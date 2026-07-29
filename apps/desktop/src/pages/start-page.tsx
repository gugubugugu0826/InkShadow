import { Badge, Card, CardContent, CardHeader, CardTitle } from "@inkshadow/ui";
import { Link } from "react-router-dom";

import { useRuntime } from "../runtime-context";

export function StartPage() {
  const runtime = useRuntime();

  return (
    <main className="start-page" data-surface="dark">
      <section className="start-page__hero" aria-labelledby="start-heading">
        <div className="start-page__brand" aria-label="InkShadow 墨影">
          <span className="start-page__mark" aria-hidden="true">
            墨
          </span>
          <span>InkShadow 墨影</span>
        </div>
        <Badge tone="success">本地优先</Badge>
        <h1 id="start-heading">从你的设备开始创作</h1>
        <p>
          无需注册或联网。项目、正文、版本和备份默认保留在当前设备，云服务不可用也不会阻断写作与导出。
        </p>
        <div className="start-page__actions">
          <Link className="button-link" to="/projects">
            本地开始
          </Link>
          <Link className="button-link button-link--secondary" to="/settings">
            导入或恢复
          </Link>
        </div>
        {runtime.featureFlags.cloudIdentity && runtime.cloudIdentity?.available === true ? (
          <Link className="start-page__cloud-link" to="/auth/login">
            登录已有云账户
          </Link>
        ) : (
          <span className="start-page__cloud-note">云账户稍后登录；本地工作区功能保持完整。</span>
        )}
      </section>

      <Card className="start-page__privacy">
        <CardHeader>
          <CardTitle>你始终保留本地控制权</CardTitle>
        </CardHeader>
        <CardContent>
          <ul>
            <li>登录、订阅和功能开关不会锁定本地正文。</li>
            <li>系统凭据库只在需要时保存秘密，备份和诊断不包含完整 Token。</li>
            <li>同步默认关闭，确认恢复材料和设备授权前不会上传密文。</li>
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}
