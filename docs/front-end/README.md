# InkShadow 前端文档

> 文档状态：`SUPPORTING_CURRENT`  
> 基于源码复核：2026-08-14  
> 当前源码目标版本（App Version）：`0.2.4`；最近已发布版本：`0.2.3`；v0.2.4 安全修复候选尚未发布  
> 设计基线（Design Baseline）：`DESIGN v0.3.1b`  
> 文档性质：实现现状说明；页面存在不等于 P01–P44 已验证

本目录记录 InkShadow 当前前端代码的真实入口、页面文件、页面内容、能力边界和接口。
它与 `docs/prototypes/` 中的原型规划不同：原型文档说明目标形态，本目录说明当前源码已经注册
和接线的内容。

DESIGN v0.3.1b 决定目标视觉、交互和响应式验收，不会把应用版本自动改成 0.3.1b。当前源码与
数据库配置目标版本为 0.2.4，最近已发布工程预览安装包为 0.2.3；v0.2.4 安全修复仍是未发布候选，DESIGN 版本不会替代应用版本。

## 文档导航与状态

| 状态                    | 文档                                                                                                                         | 内容                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `SUPPORTING_CURRENT`    | [`PAGE_CATALOG.md`](PAGE_CATALOG.md)                                                                                         | Desktop 全部路由、页面文件、主要操作、守卫，以及 Web Guest 单页和非路由组件    |
| `SUPPORTING_CURRENT`    | [`INTERFACE_REFERENCE.md`](INTERFACE_REFERENCE.md)                                                                           | DesktopRuntime、Tauri IPC、SQLite、Model Hub、Cloud HTTP 与 Web Guest 数据边界 |
| `SUPPORTING_CURRENT`    | [`CREATION_JOURNEYS_AND_PROJECT_SEED.md`](CREATION_JOURNEYS_AND_PROJECT_SEED.md)                                             | 三条创建入口共享的 ProjectSeed 状态与安全合同                                  |
| `AUTHORITATIVE_CURRENT` | [`../product-rebuild/01-INFORMATION-ARCHITECTURE-AND-FLOWS.md`](../product-rebuild/01-INFORMATION-ARCHITECTURE-AND-FLOWS.md) | 普通用户三入口、四区工作台和术语基线                                           |
| `TARGET_BASELINE`       | `DESIGN/` P01–P44                                                                                                            | 目标状态；不能由本目录的文件说明替代验收                                       |

上传与发布注意事项见 [`../GITHUB_PUBLISH_RELEASE_GUIDE.md`](../GITHUB_PUBLISH_RELEASE_GUIDE.md)。

## 前端范围

| 应用      | 技术                               | 当前 UI 形态                    | 入口                         |
| --------- | ---------------------------------- | ------------------------------- | ---------------------------- |
| Desktop   | React、Vite、React Router、Tauri 2 | Hash Router 桌面应用            | `apps/desktop/src/main.tsx`  |
| Web       | React、Vite、WebCrypto、IndexedDB  | 无路由的 Guest 加密工作区单页   | `apps/web/src/main.tsx`      |
| Cloud API | Fastify/Node 服务                  | 无前端页面                      | `apps/cloud-api/src/main.ts` |
| Android   | Kotlin 核心与 KeyStore POC         | 当前没有 Activity 或 Compose UI | `apps/android/`              |

## 关键边界

- Desktop 页面不直接访问 SQLite、系统凭据、项目密钥或任意网络地址；这些能力通过
  `DesktopRuntime` 和受限的 Tauri command 暴露。
- 启动、登录和三条创建旅程等不使用 `AppShell` 的页面会在视口内独立纵向滚动，小窗口下不会因
  安全区域、居中或 `body` 锁定而裁掉顶部和底部操作。
- Desktop 壳层只渲染一个 `<main>` 主地标，主内容区承担视口内滚动；窄窗口导航使用带遮罩、
  Escape 关闭、焦点圈定、背景隔离和焦点恢复的抽屉。路由切换会同步页面标题并把焦点移到新页
  一级标题，页内锚点则由目标页面接管焦点。
- Desktop 外观支持“跟随系统、浅色、深色”三态。偏好在 React 挂载前应用并保存于本机；
  系统模式会响应操作系统变化，编辑纸张仍可维持独立、适合长文的阅读表面。
- 默认首页只突出“从一个想法开始、导入小说、专业创建”；已有作品以最近创作/继续写作为
  补充投影，不取代三条核心入口。
- 项目内普通一级导航固定为正文、规划、设定、检查。搜索、故事关联、从正文更新设定、素材、
  多智能体、模型路由、Trace 和任务队列通过相应页面内入口、状态入口或专家模式渐进披露，
  不作为普通用户并列一级模块。
- 云会话 Token 保留在原生安全边界，WebView 只通过允许列表中的 relay 请求访问 Cloud API。
- Web Guest 不是桌面工作区镜像。它只在浏览器内存、WebCrypto 和 IndexedDB 中管理独立加密
  项目。
- 高级桌面页面即使注册了路由，也可能因 Feature Flag、原生运行时、网络、登录、团队权限或
  项目密钥未满足而重定向或显示受限状态。
- 页面中的计划文案、测试 Fixture 或类型定义不等于生产服务已部署；以运行时接线和发布门禁
  为准。
- 连续状态提取、章节摘要、AI 模糊/质量复核和剧情规划均为明确触发、可审阅的模型能力；
  缺少 Model Hub 路由、有效能力证据或用户凭据时会跳过，不能把页面入口当作真实供应商验收。

## Model Hub 的普通与专家体验

- 普通模式只让用户连接供应商、填写必要账户字段、测试连接、选择发现或明确填写的模型，并
  选择智能推荐、高质量、经济模式、本地隐私或完全自定义方案。
- 开书页快捷连接当前提供 DeepSeek、OpenAI、阿里云百炼/Qwen、火山方舟/豆包、Ollama、
  智谱 GLM 和自定义 OpenAI-compatible。需要账号模型或 Endpoint ID 的供应商不会伪造目录，
  而是先用不含作品内容的固定文本探针验证。
- 专家模式才显示 Base URL、受限相对路径、Header 名、超时、重试、能力证据、逐任务主/备用
  模型、费用和隐私覆盖。密钥值始终留在操作系统凭据库。
- 推荐依据能力证据、连接状态、用户策略和评测，不把某个具体模型或供应商永久写死为最佳。
- 连接成功、目录有模型或 HTTP 200 都不等于真实写作任务可用；最终还要核对精确供应商、模型、
  任务回执、可见输出、持久化和失败恢复。

## Web Guest 非页面客户端文件

这些文件没有独立路由，但仍属于浏览器前端，不是 Cloud 后端：

| 文件                                                                | 内容                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/contracts/encrypted-guest-project.ts`                 | 密文记录、项目密钥 envelope、KDF、AAD、nonce 和 CAS 的严格 schema。                                                 |
| `apps/web/src/contracts/encrypted-guest-draft.ts`                   | 自动锁定恢复所用临时章节密文的严格 schema 与绑定校验。                                                              |
| `apps/web/src/domain/guest-workspace-error.ts`                      | Web Guest 稳定客户端错误。                                                                                          |
| `apps/web/src/ports/encrypted-project-store.ts`                     | 加密项目存储端口。                                                                                                  |
| `apps/web/src/application/guest-workspace-service.ts`               | 创建、严格密文导入、一次性恢复材料、提交、解锁、CAS 保存、密文导出、临时密文恢复、锁定和 session epoch 防陈旧操作。 |
| `apps/web/src/infrastructure/indexed-db-encrypted-project-store.ts` | IndexedDB `inkshadow-web-guest-v1` 的项目密文和临时恢复密文事务实现。                                               |
| `apps/web/src/infrastructure/session-project-keyring.ts`            | 仅在内存中保存不可导出的活动 AES key。                                                                              |
| `apps/web/src/infrastructure/web-crypto-envelope-service.ts`        | 32 字节项目密钥/恢复材料、PBKDF2-SHA256、AES-256-GCM、AAD、nonce、Base64URL 和临时值清理。                          |
| `apps/web/src/bootstrap.ts`                                         | 组合 Web Guest 的 store、keyring、crypto service 和应用服务。                                                       |

IndexedDB 持久化的是项目密文、由恢复材料包装的项目密钥 envelope，以及自动锁定前尽力写入
的临时恢复密文；原始恢复材料、正文和活动 `CryptoKey` 不会以明文写入浏览器存储。手动锁定
遇到未保存修改时会要求“保存后锁定”或明确放弃；页面隐藏或离开触发自动锁定时，会先尝试
保存正式密文和临时恢复密文，再清除可见正文与会话密钥。正式保存失败但临时密文成功时，
下次用恢复材料解锁会恢复该草稿；两种写入都失败时页面会明确警告可能无法恢复。

Web Guest 也支持导入本页导出的 `.encrypted.json` 副本。文件大小上限为 32 MiB；只有在 JSON、
记录 schema、信封绑定、恢复材料和解密后领域数据全部验证成功后，才会创建 IndexedDB 记录。
重复项目、损坏副本或错误恢复材料均失败关闭，不留下部分项目。Web Guest 当前没有服务端或
云同步。

## 页面细节整改基线

2026-07-31 的页面细节整改还确立了以下前端约定：

- 每个主要页面保留一个一级标题，卡片和分区使用与页面结构匹配的二级或三级标题；
- 未知 Desktop 路径显示明确的“页面不存在”状态和返回项目入口，不再静默重定向；
- 设置页提供分区目录和可聚焦锚点，项目页的导入、恢复入口可直达对应区域；
- 新建/重命名项目和新建章节的 Enter 提交会忽略中文输入法组合态；
- 项目生命周期操作提供明确成功反馈，移入回收站还提供撤销；团队角色、移除成员及项目权限
  变更均先进入确认步骤；
- 团队模板页面主体文案已统一为中文；
- Web Guest 风险说明允许拒绝并在不载入正文和密钥的状态下重新查看；恢复材料可下载为带项目
  名称与完整项目标识的文件。

## 维护规则

发生以下变化时必须同步更新本目录：

1. `apps/desktop/src/app.tsx` 新增、删除或修改路由；
2. `apps/desktop/src/pages/` 新增、重命名或拆分页面；
3. `DesktopRuntime`、Tauri command、原生事件或 Cloud API operation 变化；
4. `apps/web/src/app.tsx` 或 `GuestWorkspaceService` 的用户流程变化；
5. Feature Flag 默认值或依赖关系变化；
6. 页面从“仅注册/受限”晋级为真实可用，或已实现能力被关闭。

维护时优先核对这些权威来源：

- `apps/desktop/src/app.tsx`
- `apps/desktop/src/components/desktop-shell.tsx`
- `apps/desktop/src/infrastructure/runtime.ts`
- `apps/desktop/src-tauri/src/lib.rs`
- `packages/config/src/feature-flags.ts`
- `packages/contracts/src/cloud-openapi.ts`
- `packages/contracts/src/openapi.ts`（仅测试/文档生成子入口）
- `apps/web/src/app.tsx`
- `apps/web/src/application/guest-workspace-service.ts`

## GitHub 发布范围

本目录属于根 `.gitignore` 允许的精选公开文档范围。发布前仍须查看 `git status` 和暂存清单，
确保只提交允许的 Markdown，不包含内部审计原文、凭据、数据库、安装缓存或本机构建目录。
不要用 `git add -f` 绕过公开范围。
