import { parseUuidV7 } from "@inkshadow/domain";
import { ErrorState, InlineAlert } from "@inkshadow/ui";
import { Link, useParams } from "react-router-dom";

import { ContextHistoryPanel } from "../components/context-history-panel";
import { useRuntime } from "../runtime-context";

export function ContextSourcesPage() {
  const runtime = useRuntime();
  const { projectId: projectIdValue = "" } = useParams<{ projectId: string }>();
  const parsedProjectId = parseUuidV7(projectIdValue);

  if (!parsedProjectId.ok) {
    return (
      <div className="desktop-page">
        <ErrorState
          title="无法读取本次参考记录"
          description="项目地址无效。请返回作品库，重新打开这部作品。"
          primaryAction={{ label: "返回作品库", onClick: () => history.back() }}
        />
      </div>
    );
  }

  return (
    <div className="desktop-page context-sources-page">
      <header className="page-heading">
        <div>
          <Link className="back-link" to={`/projects/${parsedProjectId.value}`}>
            返回正文
          </Link>
          <p className="page-heading__eyebrow">可追溯的 AI 创作</p>
          <h1>本次参考</h1>
          <p>每次生成实际采用了什么、为什么采用，以及哪些资料因篇幅没有发送。</p>
        </div>
      </header>

      <InlineAlert
        tone="info"
        title="这里只保存来源记录"
        description="记录不会重复保存正文、创作指令或 AI 回复；使用云端 AI 时，只有当次被选中的内容才会发送给已连接的供应商。"
      />

      <ContextHistoryPanel
        projectId={parsedProjectId.value}
        store={runtime.contextTraces}
        novelSkills={runtime.novelSkills}
      />
    </div>
  );
}
