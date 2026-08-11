import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "../src/app";
import { GuestWorkspaceService } from "../src/application/guest-workspace-service";
import type {
  CipherEnvelopeV1,
  EncryptedGuestProjectRecordV1,
} from "../src/contracts/encrypted-guest-project";
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
      name: "进入浏览器访客工作区前",
    });
    expect(riskDialog).toHaveTextContent("清理站点数据");
    expect(riskDialog).toHaveTextContent("不是桌面数据的镜像或副本");
    expect(riskDialog).toHaveTextContent("最近修改可能未保存");
    await user.click(
      within(riskDialog).getByRole("button", {
        name: "我理解风险，进入工作区",
      }),
    );

    await screen.findByRole("heading", { name: "创建加密项目" });
    expect(screen.getByRole("button", { name: "创建加密项目" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "潮汐信使");
    const chapterTitle = screen.getByRole("textbox", { name: "首章标题" });
    await user.clear(chapterTitle);
    await user.type(chapterTitle, "夜航");
    await user.type(screen.getByRole("textbox", { name: /^首章正文/u }), UI_BODY_CANARY);
    expect(screen.getByRole("button", { name: "创建加密项目" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "创建加密项目" }));

    const recoveryDialog = await screen.findByRole("dialog", {
      name: "现在保存恢复材料",
    });
    const recoveryMaterial = within(recoveryDialog)
      .getByTestId("recovery-material")
      .textContent.trim();
    expect(recoveryMaterial).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(recoveryDialog).toHaveTextContent("潮汐信使");
    expect(recoveryDialog.textContent).toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u,
    );
    expect(
      within(recoveryDialog).getByRole("button", {
        name: "下载带项目标识的恢复文件",
      }),
    ).toBeEnabled();
    await user.click(
      within(recoveryDialog).getByRole("checkbox", {
        name: /我已把.*恢复材料保存到浏览器之外/u,
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
    fireEvent.change(editor, { target: { value: UI_UPDATED_CANARY } });
    await user.click(screen.getByRole("button", { name: "保存密文版本" }));
    await waitFor(() => {
      expect(screen.getByText("已保存到本地")).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: "立即锁定" }));
    expect(screen.queryByDisplayValue(UI_UPDATED_CANARY)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "仅本次会话解锁" })).toBeVisible();

    const recoveryInput = screen.getByLabelText("恢复材料", { exact: true });
    fireEvent.change(recoveryInput, {
      target: { value: changeLastCharacter(recoveryMaterial) },
    });
    await user.click(screen.getByRole("button", { name: "仅本次会话解锁" }));
    expect(await screen.findByText(/WEB_UNLOCK_FAILED/u)).toBeVisible();
    expect(screen.queryByDisplayValue(UI_UPDATED_CANARY)).not.toBeInTheDocument();

    fireEvent.change(recoveryInput, { target: { value: recoveryMaterial } });
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
    expect(capabilityPanel).toHaveTextContent("桌面项目文件夹与本地数据库");
    expect(within(capabilityPanel).getAllByText("不可用")).toHaveLength(4);
  });

  it("keeps page card headings directly below the main h1", async () => {
    const user = userEvent.setup();
    render(<App service={new GuestWorkspaceService(new MemoryEncryptedProjectStore())} />);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "我理解风险，进入工作区",
      }),
    );

    const main = screen.getByRole("main");
    const headings = within(main).getAllByRole("heading");
    expect(headings[0]?.tagName).toBe("H1");
    const firstSubheading = headings.find((heading) => heading.tagName !== "H1");
    expect(firstSubheading?.tagName).toBe("H2");
    expect(
      headings.every(
        (heading, index) =>
          heading.tagName !== "H3" ||
          headings.slice(0, index).some((previous) => previous.tagName === "H2"),
      ),
    ).toBe(true);
  });

  it("lets the user decline the risk notice without entering the workspace", async () => {
    const user = userEvent.setup();
    const service = new GuestWorkspaceService(new MemoryEncryptedProjectStore());
    render(<App service={service} />);

    const riskDialog = await screen.findByRole("dialog", {
      name: "进入浏览器访客工作区前",
    });
    await user.click(within(riskDialog).getByRole("button", { name: "暂不进入" }));

    const declinedDialog = await screen.findByRole("dialog", { name: "尚未进入工作区" });
    expect(declinedDialog).toHaveTextContent("项目密钥和正文均未载入");
    await user.click(within(declinedDialog).getByRole("button", { name: "重新查看风险说明" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "进入浏览器访客工作区前" })).getByRole(
        "button",
        { name: "我理解风险，进入工作区" },
      ),
    );

    expect(await screen.findByRole("heading", { name: "访客写作工作区" })).toBeVisible();
  });

  it("imports an encrypted backup only after pairing it with recovery material", async () => {
    const source = new GuestWorkspaceService(new MemoryEncryptedProjectStore());
    const created = await source.createEncryptedProject({
      projectName: "海雾归档",
      chapterTitle: "灯塔",
      chapterContent: UI_BODY_CANARY,
    });
    const backup = await source.exportEncryptedProject(created.session.project.id);
    const user = userEvent.setup();
    const destinationStore = new MemoryEncryptedProjectStore();
    render(<App service={new GuestWorkspaceService(destinationStore)} />);

    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "我理解风险，进入工作区",
      }),
    );
    const file = new File([backup], "inkshadow-backup.encrypted.json", {
      type: "application/json",
    });
    await user.upload(screen.getByLabelText("墨影加密副本"), file);
    await user.type(screen.getByLabelText("对应的恢复材料"), created.recoveryMaterial);
    const importButton = screen.getByRole("button", { name: "验证并恢复项目" });
    expect(importButton).toBeEnabled();
    const importForm = importButton.closest("form");
    if (importForm === null) {
      throw new Error("Import form is missing.");
    }
    fireEvent.submit(importForm);

    await waitFor(async () => {
      expect(await destinationStore.list()).toHaveLength(1);
    });
    expect(await screen.findByRole("heading", { name: "海雾归档" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: /^章节正文/u })).toHaveValue(UI_BODY_CANARY);
    expect(await destinationStore.list()).toHaveLength(1);
  });

  it("saves dirty content before a manual lock and restores the saved version", async () => {
    const user = userEvent.setup();
    const store = new MemoryEncryptedProjectStore();
    const service = new GuestWorkspaceService(store);
    const created = await service.createEncryptedProject({
      projectName: "手动锁定保护",
      chapterTitle: "第一章",
      chapterContent: UI_BODY_CANARY,
    });
    service.lockAll();
    render(<App service={service} />);

    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "我理解风险，进入工作区",
      }),
    );
    await screen.findByRole("button", { name: "仅本次会话解锁" });
    await user.type(screen.getByLabelText("恢复材料", { exact: true }), created.recoveryMaterial);
    await user.click(screen.getByRole("button", { name: "仅本次会话解锁" }));
    const editor = await screen.findByRole("textbox", { name: /^章节正文/u });
    await user.clear(editor);
    await user.type(editor, UI_UPDATED_CANARY);
    await user.click(screen.getByRole("button", { name: "立即锁定" }));

    const lockDialog = await screen.findByRole("dialog", { name: "有修改尚未保存" });
    await user.click(within(lockDialog).getByRole("button", { name: "继续编辑" }));
    expect(screen.getByRole("textbox", { name: /^章节正文/u })).toHaveValue(UI_UPDATED_CANARY);
    await user.click(screen.getByRole("button", { name: "立即锁定" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "有修改尚未保存" })).getByRole("button", {
        name: "保存并锁定",
      }),
    );

    await screen.findByRole("button", { name: "仅本次会话解锁" });
    await user.type(screen.getByLabelText("恢复材料", { exact: true }), created.recoveryMaterial);
    await user.click(screen.getByRole("button", { name: "仅本次会话解锁" }));
    expect(await screen.findByDisplayValue(UI_UPDATED_CANARY)).toBeVisible();
  });

  it("keeps the editor and plaintext available when manual save-and-lock fails", async () => {
    const user = userEvent.setup();
    const store = new AppendFailureEncryptedProjectStore();
    const service = new GuestWorkspaceService(store);
    const created = await service.createEncryptedProject({
      projectName: "锁定失败保护",
      chapterTitle: "第一章",
      chapterContent: UI_BODY_CANARY,
    });
    service.lockAll();
    render(<App service={service} />);

    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "我理解风险，进入工作区",
      }),
    );
    await screen.findByRole("button", { name: "仅本次会话解锁" });
    await user.type(screen.getByLabelText("恢复材料", { exact: true }), created.recoveryMaterial);
    await user.click(screen.getByRole("button", { name: "仅本次会话解锁" }));
    const editor = await screen.findByRole("textbox", { name: /^章节正文/u });
    await user.clear(editor);
    await user.type(editor, UI_UPDATED_CANARY);
    await user.click(screen.getByRole("button", { name: "立即锁定" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "有修改尚未保存" })).getByRole("button", {
        name: "保存并锁定",
      }),
    );

    expect(await screen.findByDisplayValue(UI_UPDATED_CANARY)).toBeVisible();
    expect(await screen.findByText(/WEB_STORAGE_FAILED/u)).toBeVisible();
    expect(service.isUnlocked(created.session.project.id)).toBe(true);
  });

  it("saves dirty content before an automatic visibility lock", async () => {
    const user = userEvent.setup();
    const store = new MemoryEncryptedProjectStore();
    const service = new GuestWorkspaceService(store);
    const created = await service.createEncryptedProject({
      projectName: "自动锁定保存",
      chapterTitle: "第一章",
      chapterContent: UI_BODY_CANARY,
    });
    service.lockAll();
    render(<App service={service} />);

    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "我理解风险，进入工作区",
      }),
    );
    await screen.findByRole("button", { name: "仅本次会话解锁" });
    await user.type(screen.getByLabelText("恢复材料", { exact: true }), created.recoveryMaterial);
    await user.click(screen.getByRole("button", { name: "仅本次会话解锁" }));
    const editor = await screen.findByRole("textbox", { name: /^章节正文/u });
    await user.clear(editor);
    await user.type(editor, UI_UPDATED_CANARY);

    setDocumentVisibility("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByRole("button", { name: "仅本次会话解锁" });
    setDocumentVisibility("visible");
    await user.type(screen.getByLabelText("恢复材料", { exact: true }), created.recoveryMaterial);
    await user.click(screen.getByRole("button", { name: "仅本次会话解锁" }));

    expect(await screen.findByDisplayValue(UI_UPDATED_CANARY)).toBeVisible();
  });

  it("recovers a ciphertext-only draft when an automatic lock cannot commit", async () => {
    const user = userEvent.setup();
    const store = new AppendFailureEncryptedProjectStore();
    const service = new GuestWorkspaceService(store);
    const created = await service.createEncryptedProject({
      projectName: "自动锁定失败",
      chapterTitle: "第一章",
      chapterContent: UI_BODY_CANARY,
    });
    service.lockAll();
    render(<App service={service} />);

    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "我理解风险，进入工作区",
      }),
    );
    await screen.findByRole("button", { name: "仅本次会话解锁" });
    await user.type(screen.getByLabelText("恢复材料", { exact: true }), created.recoveryMaterial);
    await user.click(screen.getByRole("button", { name: "仅本次会话解锁" }));
    const editor = await screen.findByRole("textbox", { name: /^章节正文/u });
    await user.clear(editor);
    await user.type(editor, UI_UPDATED_CANARY);

    setDocumentVisibility("hidden");
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => {
      expect(screen.queryByDisplayValue(UI_UPDATED_CANARY)).not.toBeInTheDocument();
    });
    expect(await screen.findByText(/未保存修改已写入仅含密文的临时恢复副本/u)).toBeVisible();
    const temporaryDraft = store.inspectTemporaryDraft(created.session.project.id);
    expect(temporaryDraft).not.toBeNull();
    expect(JSON.stringify(temporaryDraft)).not.toContain(UI_UPDATED_CANARY);
    expect(JSON.stringify(temporaryDraft)).not.toContain(created.recoveryMaterial);
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
    expect(service.isUnlocked(created.session.project.id)).toBe(false);
    setDocumentVisibility("visible");
    await user.type(screen.getByLabelText("恢复材料", { exact: true }), created.recoveryMaterial);
    await user.click(screen.getByRole("button", { name: "仅本次会话解锁" }));

    expect(await screen.findByDisplayValue(UI_UPDATED_CANARY)).toBeVisible();
    expect(await screen.findByText("已恢复临时加密草稿")).toBeVisible();
    expect(screen.getByText("有未保存更改")).toBeVisible();
  }, 15_000);

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

  it("warns before leaving, saves dirty content and then locks on pagehide", async () => {
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
    await user.type(screen.getByLabelText("恢复材料", { exact: true }), created.recoveryMaterial);
    await user.click(screen.getByRole("button", { name: "仅本次会话解锁" }));
    const editor = await screen.findByDisplayValue("PAGEHIDE_PLAINTEXT_CANARY_861a");
    await user.clear(editor);
    await user.type(editor, UI_UPDATED_CANARY);

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    fireEvent(window, beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);
    fireEvent(window, new Event("pagehide"));

    await waitFor(() => {
      expect(screen.queryByDisplayValue(UI_UPDATED_CANARY)).not.toBeInTheDocument();
    });
    expect(await screen.findByRole("button", { name: "仅本次会话解锁" })).toBeVisible();
    expect(service.isUnlocked(created.session.project.id)).toBe(false);
    await user.type(screen.getByLabelText("恢复材料", { exact: true }), created.recoveryMaterial);
    await user.click(screen.getByRole("button", { name: "仅本次会话解锁" }));
    expect(await screen.findByDisplayValue(UI_UPDATED_CANARY)).toBeVisible();
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
        name: /我已把.*恢复材料保存到浏览器之外/u,
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

class AppendFailureEncryptedProjectStore extends MemoryEncryptedProjectStore {
  public override appendChapter(
    projectId: string,
    expectedContentVersion: number,
    envelope: CipherEnvelopeV1,
  ): Promise<void> {
    void projectId;
    void expectedContentVersion;
    void envelope;
    return Promise.reject(
      new GuestWorkspaceError("WEB_STORAGE_FAILED", "测试模拟：浏览器未能写入最新加密版本。", true),
    );
  }
}
