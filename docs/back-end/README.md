# InkShadow 非前端工程文档

> 文档状态：`SUPPORTING_CURRENT`  
> 基于源码复核：2026-08-31  
> 当前发布目标：`0.2.16`；当前源码迁移上限为 Data `0082`／Tauri `85`，本轮没有新增迁移；候选提交、安装包、标签和 Release 结果以最终发布证据为准  
> 设计基线（Design Baseline）：`DESIGN v0.3.1b`  
> 文档性质：当前实现指引，不把计划代码描述成已部署能力

## 0. 0.2.16 当前事实

- F17 的服务端响应不是失败源；失败发生在桌面生产 SQLite 提交隔离结果时。`SqliteContextTraceOutputCommitUnitOfWork` 现在查询、写入并在幂等比较中核对 `selection_action`，满足已发布 `0080` 守卫。四种选区操作继续保存为隔离结果，作者接受前不写正文。
- 本地提交失败且已有可见片段时，生成离开边界提供复制或明确放弃后离开；两条路径都释放当前会话，不回滚或改写正文、不可变版本和历史候选，也不自动重发已经发生的供应商调用。
- 章节隐私继续使用带预期修订的权威用例；页面只在持久化成功后显示新状态，失败时保留支持编号、重试与重新读取。私密章节仍在模型网关、同步与包含正文的远程任务之前失败关闭。
- 自定义技能任务范围只从明确任务段落整理，避免规则正文中的普通关键词错误收窄采用范围。检查页准备、任务通知全批次标为已读或清除、费用未知说明和示例身份继续复用既有生产存储，不新增第二事实源；清除通知不删除关联任务或本地审计。
- 当前源码保持 Data `0082_author_recovery_records.sql`／Tauri `85` 上限；0.2.16 不新增迁移，不改动 v0.2.15 及更早迁移字节、校验和、标签、Release 或附件。
- 当前结论来自源码和自动化；现场数据库、截图、完整诊断与供应商响应未取得，真实供应商调用和 0.2.16 真实安装程序人工验证尚未执行。

## 0.1 0.2.15 历史事实

- 开书使用可恢复旅程、稳定方案槽位和同一次调用标识串联发送前检查、披露、调用预留、原生发送边界、隔离结果与终态；三方案按三个稳定槽位分别记录，单方案只派发作者明确选择的槽位。页面离开或失败不会把模型结果写入正文，也不会自动重发结果待核对的调用。
- 写作技能默认关闭。当前项目有效绑定与作者仅为当前调用明确选择的技能都会在有界预算内编译，但一次性选择不会写入或重开项目绑定；开书动作会为当前两项官方技能预留 2000 的专用文字预算，并继续服从总上下文和最多六项限制。采用快照在发送前绑定项目、任务、技能身份、版本与调用，开书和正文生成共用同一采用链。技能准备、保存或派发前核对失败会停止该次发送，不会伪造已采用状态。
- F10 已按能力分流：文字能力检查走原生生成命令，语义向量能力检查走原生向量命令和供应商向量端点；未知能力要求作者先选择并保持零发送。向量结果必须通过模型身份、条目数、维度、有限数值与非零向量校验后，才可形成能力证据。
- U8 的“编辑并重试”只面向仍处于活动状态的失败连接。编辑非敏感连接参数默认沿用已有系统凭据，保存使用加载时修订号；陈旧页面不能覆盖新设置。成功重试更新为可用，失败重试保留连接、凭据和再次编辑入口，退役仍是独立的明确操作。
- 原生导出由选择目标、写入制品和打开文件三个受控命令组成。目标票据为短期、单次消费并绑定格式、媒体类型、父目录与目标身份；写入使用临时文件、原子安装和最终字节数／SHA-256 回读核验；打开命令只接受已存在的绝对普通文件和允许的导出扩展名，不接受任意命令或控制字符路径。
- 0.2.15 当前源码沿用已提交的 Data `0082_author_recovery_records.sql`／Tauri `85`；本轮后续缺陷修复没有再新增迁移。v0.2.14 及更早迁移字节、校验和、标签、Release 和附件保持不变。
- 当前结论来自源码与自动化复核；真实供应商调用和 0.2.15 真实安装程序人工验证尚未执行，不得把可控网关或单元测试写成真实服务验证。

`v0.2.6` 已冻结发布 Data `0071` / Tauri `74` 的本地数据库、自动备份和能力验证调用审计修复。
`v0.2.7` 只向前追加到 Data `0075` / Tauri `78`，区分正文结果与方向用途，
并补充用户故事事实修订、版本整理责任和隐私快照规则；最终候选、远端门禁、未签名打包和公开预发行已完成，真实供应商、最终安装程序真机与商业门禁仍未完成。
`v0.2.9` 继续向前追加 Data `0076`–`0077` / Tauri `79`–`80`。0.2.10 与 0.2.11 均未修改已发布迁移，0.2.11 只作为人工复测候选。
Data `0078_generation_attempt_prose_invocation.sql` / Tauri `81` 已属于 v0.2.12 发布历史。0.2.14 只向前新增 Data `0079_story_fact_evidence.sql`／Tauri `82`、`0080_candidate_selection_action.sql`／Tauri `83` 和 `0081_story_fact_evidence_guard_performance.sql`／Tauri `84`：前三者分别保留一条事实的多处不可变证据、冻结四项选区动作，并在保持精确 UTF-16 证据保护的同时消除长正文递归校验的重复字节读取；不得修改 `0078` 或更早迁移字节与校验。
0.2.16 当前差异与边界见
[`../execution/2026-08-30-V0216-RELEASE.md`](../execution/2026-08-30-V0216-RELEASE.md)；0.2.15 及更早记录继续作为历史证据保留。

InkShadow 不是只有“前端”和“后端”两块。除用户界面外，仓库还包含：

1. Cloud API 服务端；
2. Tauri/Rust 桌面原生层；
3. 可被多个应用复用的领域、应用、数据和安全包；
4. Android 离线与 KeyStore POC；
5. 部署、备份、恢复、发布、检查和测试工具。

本目录以 `back-end` 作为便于查找的统一入口，但不会把共享领域包、Android 或工程脚本错误地
称为云后端。

DESIGN v0.3.1b 只约束目标界面与交互验收；它不会改变 Tauri、数据库或 Desktop 应用版本。
当前发布目标为 0.2.16；候选提交、安装包和人工复测状态只能由本轮最终证据确认。v0.2.15 及更早标签、Release、附件、安装包和来源证据保持不变。

## 文档导航与状态

| 状态                    | 文档                                                                                                     | 内容与边界                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `SUPPORTING_CURRENT`    | [`CLOUD_BACKEND.md`](CLOUD_BACKEND.md)                                                                   | Cloud API、PostgreSQL、HTTP、服务和后台任务；代码存在不表示生产 Cloud 已部署          |
| `SUPPORTING_CURRENT`    | [`DESKTOP_NATIVE.md`](DESKTOP_NATIVE.md)                                                                 | 桌面原生可信边界、本地数据库、凭据、模型网络、项目密钥和备份；工作树原生迁移上限 `85` |
| `SUPPORTING_CURRENT`    | [`SHARED_PACKAGES.md`](SHARED_PACKAGES.md)                                                               | 工作区领域、应用、数据、导入导出和共享界面包；工作树数据迁移上限 `0082`               |
| `SUPPORTING_CURRENT`    | [`ANDROID_OPERATIONS_TOOLING.md`](ANDROID_OPERATIONS_TOOLING.md)                                         | Android POC、部署模板、发布/安全脚本、CI 和 E2E；不属于当前默认创作主链路             |
| `AUTHORITATIVE_CURRENT` | [`../product-rebuild/02-DATA-REUSE-AND-MIGRATION.md`](../product-rebuild/02-DATA-REUSE-AND-MIGRATION.md) | 数据复用、前向迁移与回滚规则                                                          |

- [`../front-end/README.md`](../front-end/README.md)：用户页面、路由和前端接口。
- [`../GITHUB_PUBLISH_RELEASE_GUIDE.md`](../GITHUB_PUBLISH_RELEASE_GUIDE.md)：GitHub 上传与
  Release 流程。

## 一张表理解仓库

| 区域                     | 是否有页面 | 主要职责                                         | 主要入口                     |
| ------------------------ | ---------- | ------------------------------------------------ | ---------------------------- |
| `apps/desktop/src`       | 有         | Desktop React UI 和前端运行时接线                | `main.tsx`、`app.tsx`        |
| `apps/web/src`           | 有         | Web Guest 加密写作单页                           | `main.tsx`、`app.tsx`        |
| `apps/desktop/src-tauri` | 无         | Desktop 原生权限、数据、网络和系统能力           | `src/main.rs`、`src/lib.rs`  |
| `apps/cloud-api/src`     | 无         | Cloud HTTP API、业务服务和后台任务               | `main.ts`                    |
| `packages/*/src`         | 无业务页面 | 跨应用领域模型、用例、契约、存储及共享 UI 基础件 | 各包 `index.ts`              |
| `apps/android`           | 当前无     | Android 离线同步、密文缓存和 KeyStore POC        | `core/`、`android-keystore/` |
| `deploy/`                | 无         | Enterprise 容器、Kubernetes、监控和升级          | `deploy/enterprise/`         |
| `scripts/`               | 无         | 发布、安全检查、备份恢复和 E2E 驱动              | 根 `package.json` scripts    |
| `tests/`                 | 无         | 跨应用 Desktop E2E                               | `tests/e2e/`                 |

`apps/web/src/application`、`domain`、`contracts`、`ports` 和 `infrastructure` 虽然没有页面，
仍运行在浏览器侧，不是服务端；它们的逐文件说明保留在
[`../front-end/README.md`](../front-end/README.md)。

## 依赖方向

推荐阅读顺序：

```text
domain / story-core / ai-core / sync-core / access-core
                         ↓
                 application / task-engine
                         ↓
     data / cloud-client / import-export / observability
                         ↓
       Desktop Runtime / Cloud API / Web / Android
                         ↓
                React 页面与 Tauri 壳层
```

依赖方向由 `scripts/check-boundaries.mjs` 校验。应用层和领域层不应反向依赖 React、Tauri、
Fastify、PostgreSQL 或具体 UI。

## “文件存在”不等于“线上可用”

判断一个非前端能力是否真的可用，需要同时核对：

- 代码和契约是否存在；
- 运行时是否接线；
- Feature Flag 是否开启；
- Tauri 原生安全允许列表是否放行；
- PostgreSQL、对象存储、邮件、身份提供商等真实依赖是否部署；
- 数据库迁移、权限角色和 RLS 是否通过；
- 对应测试、安装或运维演练是否完成。

Cloud API 有完整的契约和大量实现，但当前工程预览版没有托管生产 Cloud；团队审阅、AI
用量、Enterprise 和团队模板等部分 Desktop 请求仍被原生中继阻止。

## 维护规则

发生以下变化时更新对应文档：

- `apps/cloud-api/src`、`migrations/` 新增或移动文件；
- `apps/desktop/src-tauri/src` 新增 command、事件、权限或网络出口；
- `packages/*/src` 新增模块或改变包边界；
- Android POC 新增 UI、真机测试或正式同步能力；
- `deploy/`、`.github/workflows/`、`scripts/` 改变发布和运维行为。

本目录属于根 `.gitignore` 允许的精选公开文档范围。发布前仍须检查暂存清单，避免把内部审计、
凭据、数据库、安装缓存或本机构建输出带入公开仓库；不要使用 `git add -f` 绕过范围。
