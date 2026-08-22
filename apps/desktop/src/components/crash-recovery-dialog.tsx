import { Button, Dialog, InlineAlert } from "@inkshadow/ui";

const RECOVERY_PREVIEW_CHARACTER_LIMIT = 4_000;

export interface CrashRecoveryDialogProps {
  readonly busy: boolean;
  readonly canSaveAsCopy: boolean;
  readonly draftContent: string;
  readonly draftUpdatedAt: string;
  readonly open: boolean;
  readonly stableContent: string;
  readonly onKeepStable: () => void;
  readonly onRecoverDraft: () => void;
  readonly onSaveAsCopy: () => void;
}

function createRecoveryPreview(content: string): string {
  if (content.length <= RECOVERY_PREVIEW_CHARACTER_LIMIT) {
    return content;
  }
  return `${content.slice(0, RECOVERY_PREVIEW_CHARACTER_LIMIT)}\n\n…（预览已截断，完整内容仍安全保留）`;
}

export function CrashRecoveryDialog({
  busy,
  canSaveAsCopy,
  draftContent,
  draftUpdatedAt,
  open,
  stableContent,
  onKeepStable,
  onRecoverDraft,
  onSaveAsCopy,
}: CrashRecoveryDialogProps) {
  const formattedUpdatedAt = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(draftUpdatedAt));

  return (
    <Dialog
      open={open}
      dismissible={false}
      onOpenChange={() => undefined}
      title="发现未完成的本地草稿"
      description="稳定正文和恢复草稿都保持原样；作出明确选择前，墨影不会覆盖或删除任何一份内容。"
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onKeepStable}>
            保留稳定正文
          </Button>
          <Button variant="secondary" disabled={busy || !canSaveAsCopy} onClick={onSaveAsCopy}>
            {canSaveAsCopy ? "草稿另存为新章节" : "草稿副本已创建"}
          </Button>
          <Button loading={busy} onClick={onRecoverDraft}>
            恢复草稿继续编辑
          </Button>
        </>
      }
    >
      <div className="crash-recovery-dialog">
        <InlineAlert
          tone="warning"
          title="这是一次数据恢复选择"
          description={`恢复草稿最后更新于 ${formattedUpdatedAt}。保留稳定正文会删除这条恢复记录；“另存”会先创建完整副本，成功后才清理恢复记录。`}
        />
        <div className="crash-recovery-dialog__comparison">
          <section>
            <div>
              <h3>稳定正文</h3>
              <span>{stableContent.length.toLocaleString("zh-CN")} 字符</span>
            </div>
            <pre>{createRecoveryPreview(stableContent)}</pre>
          </section>
          <section>
            <div>
              <h3>恢复草稿</h3>
              <span>{draftContent.length.toLocaleString("zh-CN")} 字符</span>
            </div>
            <pre>{createRecoveryPreview(draftContent)}</pre>
          </section>
        </div>
      </div>
    </Dialog>
  );
}
