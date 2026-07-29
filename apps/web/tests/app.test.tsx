import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "../src/app";
import { GuestWorkspaceService } from "../src/application/guest-workspace-service";
import type { EncryptedGuestProjectRecordV1 } from "../src/contracts/encrypted-guest-project";
import { GuestWorkspaceError } from "../src/domain/guest-workspace-error";
import { MemoryEncryptedProjectStore } from "./helpers/memory-encrypted-project-store";

const UI_BODY_CANARY = "UI_BODY_CANARY_73e1：潮声盖过了钟楼的回音。";
const UI_UPDATED_CANARY = "UI_UPDATED_CANARY_c514：她把信收进了衣袋。";

describe("Web Guest UI", () => {
  it("explains first-use risk, creates real ciphertext and requires re-unlock after locking", async () => {
    const user = userEvent.setup();
    const store = new MemoryEncryptedProjectStore();
    const service = new GuestWorkspaceService(store);
    render(<App service={service} />);

    const riskDialog = await screen.findByRole("dialog", {
      name: "进入浏览器 Guest 工作区前",
    });
    expect(riskDialog).toHaveTextContent("清理站点数据");
    expect(riskDialog).toHaveTextContent("不是桌面数据的镜像或从库");
    await user.click(
      within(riskDialog).getByRole("button", {
        name: "我理解风险，进入工作区",
      }),
    );

    await screen.findByRole("heading", { name: "创建加密项目" });
    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "潮汐信使");
    const chapterTitle = screen.getByRole("textbox", { name: "首章标题" });
    await user.clear(chapterTitle);
    await user.type(chapterTitle, "夜航");
    await user.type(screen.getByRole("textbox", { name: /^首章正文/u }), UI_BODY_CANARY);
    await user.click(screen.getByRole("button", { name: "创建加密项目" }));

    const recoveryDialog = await screen.findByRole("dialog", {
      name: "现在保存恢复材料",
    });
    const recoveryMaterial = within(recoveryDialog)
      .getByTestId("recovery-material")
      .textContent.trim();
    expect(recoveryMaterial).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await user.click(
      within(recoveryDialog).getByRole("checkbox", {
        name: /我已把恢复材料保存到浏览器之外/u,
      }),
    );
    await user.click(
      within(recoveryDialog).getByRole("button", {
        name: "我已另存，保存密文项目",
      }),
    );

    expect(await screen.findByRole("heading", { name: "潮汐信使" })).toBeVisible();
    const editor = screen.getByRole("textbox", { name: /^章节正文/u });
    expect(editor).toHaveValue(UI_BODY_CANARY);
    await user.clear(editor);
    await user.type(editor, UI_UPDATED_CANARY);
    await user.click(screen.getByRole("button", { name: "保存密文版本" }));
    await waitFor(() => {
      expect(screen.getByText("已保存到本地")).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: "立即锁定" }));
    expect(screen.queryByDisplayValue(UI_UPDATED_CANARY)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "仅本次会话解锁" })).toBeVisible();

    const recoveryInput = screen.getByLabelText("恢复材料");
    await user.type(recoveryInput, changeLastCharacter(recoveryMaterial));
    await user.click(screen.getByRole("button", { name: "仅本次会话解锁" }));
    expect(await screen.findByText(/WEB_UNLOCK_FAILED/u)).toBeVisible();
    expect(screen.queryByDisplayValue(UI_UPDATED_CANARY)).not.toBeInTheDocument();

    await user.clear(recoveryInput);
    await user.type(recoveryInput, recoveryMaterial);
    await user.click(screen.getByRole("button", { name: "仅本次会话解锁" }));
    expect(await screen.findByDisplayValue(UI_UPDATED_CANARY)).toBeVisible();
  });

  it("shows unsupported desktop, cloud, team and plaintext-egress capabilities as unavailable", async () => {
    const user = userEvent.setup();
    render(<App service={new GuestWorkspaceService(new MemoryEncryptedProjectStore())} />);
    const riskDialog = await screen.findByRole("dialog");
    await user.click(
      within(riskDialog).getByRole("button", {
        name: "我理解风险，进入工作区",
      }),
    );

    const capabilityPanel = screen.getByRole("complementary", { name: "能力边界" });
    expect(capabilityPanel).toHaveTextContent("云同步");
    expect(capabilityPanel).toHaveTextContent("团队协作");
    expect(capabilityPanel).toHaveTextContent("明文外发");
    expect(capabilityPanel).toHaveTextContent("桌面项目文件夹 / SQLite");
    expect(within(capabilityPanel).getAllByText("不可用")).toHaveLength(4);
  });

  it("clears an uncommitted recovery material and plaintext when the page becomes hidden", async () => {
    const user = userEvent.setup();
    const store = new MemoryEncryptedProjectStore();
    const service = new GuestWorkspaceService(store);
    render(<App service={service} />);

    const riskDialog = await screen.findByRole("dialog");
    await user.click(
      within(riskDialog).getByRole("button", {
        name: "我理解风险，进入工作区",
      }),
    );
    await screen.findByRole("heading", { name: "创建加密项目" });
    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "隐藏即锁定");
    await user.type(
      screen.getByRole("textbox", { name: /^首章正文/u }),
      "这个明文绝不能在页面隐藏后继续显示。",
    );
    await user.click(screen.getByRole("button", { name: "创建加密项目" }));

    const recoveryDialog = await screen.findByRole("dialog", {
      name: "现在保存恢复材料",
    });
    const recoveryMaterial = within(recoveryDialog)
      .getByTestId("recovery-material")
      .textContent.trim();
    expect(await store.list()).toHaveLength(0);

    setDocumentVisibility("hidden");
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "现在保存恢复材料" })).not.toBeInTheDocument();
    });
    expect(document.body).not.toHaveTextContent(recoveryMaterial);
    expect(document.body).not.toHaveTextContent("这个明文绝不能在页面隐藏后继续显示。");
    expect(await store.list()).toHaveLength(0);
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
    setDocumentVisibility("visible");
  });

  it("locks the visible editor and clears plaintext on pagehide", async () => {
    const user = userEvent.setup();
    const store = new MemoryEncryptedProjectStore();
    const service = new GuestWorkspaceService(store);
    const created = await service.createEncryptedProject({
      projectName: "页隐藏锁定项目",
      chapterTitle: "第一章",
      chapterContent: "PAGEHIDE_PLAINTEXT_CANARY_861a",
    });
    service.lockAll();
    render(<App service={service} />);

    const riskDialog = await screen.findByRole("dialog");
    await user.click(
      within(riskDialog).getByRole("button", {
        name: "我理解风险，进入工作区",
      }),
    );
    await screen.findByRole("button", { name: "仅本次会话解锁" });
    await user.type(screen.getByLabelText("恢复材料"), created.recoveryMaterial);
    await user.click(screen.getByRole("button", { name: "仅本次会话解锁" }));
    expect(await screen.findByDisplayValue("PAGEHIDE_PLAINTEXT_CANARY_861a")).toBeVisible();

    fireEvent(window, new Event("pagehide"));

    expect(screen.queryByDisplayValue("PAGEHIDE_PLAINTEXT_CANARY_861a")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "仅本次会话解锁" })).toBeVisible();
    expect(service.isUnlocked(created.session.project.id)).toBe(false);
  });

  it("keeps recovery material in memory for a retry when encrypted storage is full", async () => {
    const user = userEvent.setup();
    const store = new QuotaExceededEncryptedProjectStore();
    render(<App service={new GuestWorkspaceService(store)} />);

    const riskDialog = await screen.findByRole("dialog");
    await user.click(
      within(riskDialog).getByRole("button", {
        name: "我理解风险，进入工作区",
      }),
    );
    await screen.findByRole("heading", { name: "创建加密项目" });
    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "配额失败");
    await user.click(screen.getByRole("button", { name: "创建加密项目" }));

    const recoveryDialog = await screen.findByRole("dialog", {
      name: "现在保存恢复材料",
    });
    const recoveryMaterial = within(recoveryDialog)
      .getByTestId("recovery-material")
      .textContent.trim();
    await user.click(
      within(recoveryDialog).getByRole("checkbox", {
        name: /我已把恢复材料保存到浏览器之外/u,
      }),
    );
    await user.click(
      within(recoveryDialog).getByRole("button", {
        name: "我已另存，保存密文项目",
      }),
    );

    expect(await within(recoveryDialog).findByText(/WEB_STORAGE_QUOTA_EXCEEDED/u)).toBeVisible();
    expect(within(recoveryDialog).getByTestId("recovery-material")).toHaveTextContent(
      recoveryMaterial,
    );
    expect(await store.list()).toHaveLength(0);
  });
});

function changeLastCharacter(value: string): string {
  const last = value.at(-1);
  if (last === undefined) {
    throw new Error("Recovery material must not be empty.");
  }
  return `${value.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

function setDocumentVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

class QuotaExceededEncryptedProjectStore extends MemoryEncryptedProjectStore {
  public override create(record: EncryptedGuestProjectRecordV1): Promise<void> {
    void record;
    return Promise.reject(
      new GuestWorkspaceError(
        "WEB_STORAGE_QUOTA_EXCEEDED",
        "浏览器站点存储空间不足。未提交本次密文。",
        true,
      ),
    );
  }
}
