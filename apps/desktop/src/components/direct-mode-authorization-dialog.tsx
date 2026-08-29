import { Button, Dialog, InlineAlert } from "@inkshadow/ui";

export interface DirectModeAuthorizationDialogProps {
  readonly open: boolean;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onAuthorize: () => void;
}

/** One-time authority for deterministic local organization; never Provider authority. */
export function DirectModeAuthorizationDialog({
  open,
  busy,
  onCancel,
  onAuthorize,
}: DirectModeAuthorizationDialogProps) {
  return (
    <Dialog
      open={open}
      dismissible={!busy}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onCancel();
      }}
      title="启用直接模式前，请确认一次"
      description="这项授权会保存在本机并随备份恢复；以后不再重复询问。"
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button loading={busy} onClick={onAuthorize}>
            同意并启用直接模式
          </Button>
        </>
      }
    >
      <InlineAlert
        tone="info"
        title="授权本地整理，不授权联网或修改正文"
        description="生成结果始终先保存为隔离的 AI 建议草稿；只有你明确选择使用后，正文和不会被改动的历史版本才会改变。随后可在本机整理有明确原文依据的普通设定。"
      />
      <ul>
        <li>这项授权不允许自动采用 AI 建议草稿；每次正文变更仍由你明确确认。</li>
        <li>整理过程不会调用模型，不会增加模型服务调用次数或费用。</li>
        <li>每条设定都保留对应的历史版本以及正文原句和位置，可重新整理。</li>
        <li>死亡、身份、核心名称、核心关系、世界规则、重大时间线和视角等重要设定不会自动确认。</li>
        <li>重要、冲突或证据不足的内容会进入现有待确认队列，由你决定。</li>
        <li>整理失败不会回滚或改动已经接受的正文和版本。</li>
        <li>可在设置中撤销授权；撤销后切回专业模式且不再自动整理。</li>
      </ul>
    </Dialog>
  );
}
