# InkShadow 前端接口与数据边界

> 基于源码快照：2026-08-20  
> 文档状态：`SUPPORTING_CURRENT`  
> 当前源码目标版本：`0.2.5`；最新已发布版本：`0.2.4`；设计基线：`DESIGN v0.3.1b`  
> 本文记录当前代码接口；它不代表所有云能力已部署或已开放

## 1. 接口总览

当前代码确认：

- 61 个 Tauri 自定义 command；
- 1 个 Tauri 自定义事件；
- 81 个 Cloud REST operation；
- Web Guest 使用 1 个 IndexedDB 数据库和 2 个 Object Store；
- 浏览器开发运行时和界面偏好使用多个有版本的 `localStorage` 键，具体清单见第 14 节；
- 正式 Desktop 业务数据使用 SQLite；
- 模型 API Key、设备私钥和云会话使用操作系统凭据库；
- 生产代码不使用 `sessionStorage` 保存业务数据或密钥。

主要权威入口：

| 范围                  | 文件                                                       |
| --------------------- | ---------------------------------------------------------- |
| Desktop 前端运行时    | `apps/desktop/src/infrastructure/runtime.ts`               |
| Tauri command 注册    | `apps/desktop/src-tauri/src/lib.rs`                        |
| Cloud REST 操作表     | `packages/contracts/src/cloud-openapi.ts`                  |
| Cloud OpenAPI 文档    | `@inkshadow/contracts/openapi`（测试/文档工具专用子入口）  |
| Cloud 客户端          | `packages/cloud-client/src/`                               |
| Cloud 服务路由        | `apps/cloud-api/src/http/`                                 |
| 前端云中继适配        | `apps/desktop/src/infrastructure/tauri-cloud-transport.ts` |
| Rust 云中继与允许列表 | `apps/desktop/src-tauri/src/cloud_session.rs`              |
| Web Guest 应用服务    | `apps/web/src/application/guest-workspace-service.ts`      |

Desktop WebView 的 CSP 只允许自身和 Tauri IPC。模型、云端和更新请求由 Rust 原生层发出，
WebView 不能直接向任意外部地址发送请求。

## 2. DesktopRuntime 前端端口

`DesktopRuntime` 定义在 `apps/desktop/src/infrastructure/runtime.ts`，页面通过
`apps/desktop/src/runtime-context.tsx` 的 `useRuntime()` 获取它。

主要分组：

| 端口                                                    | 用途                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `repositories`                                          | 项目、章节、章节隐私、版本、恢复草稿、AI 候选、内容提交和导入提交                                                      |
| `useCases`                                              | 项目/章节创建、编辑、保存、独立隐私切换、归档、回收、恢复、导入和候选决定                                              |
| `story`                                                 | 构思、大纲、统一事实、连续提取、章节摘要、严格投影、确定性/AI 检查、剧情规划、因果试演、旧试演只读历史、反馈学习和素材 |
| `taskCenter`                                            | 后台任务和通知；支持符合状态机条件的等待重试任务立即进入可运行状态                                                     |
| `generationGovernance`                                  | 生成预算、运行、尝试、取消、重试和用量                                                                                 |
| `usageCenter`                                           | 只读本地调用账本；Tauri 提供 SQLite reader，浏览器开发模式为 `null`                                                    |
| `modelHub`、`modelGateway`、`rerank`、`imageGeneration` | 供应商连接、目录、能力证据、小说任务分工、生成/Embedding/Rerank/图片和调用账本                                         |
| `modelCenter`、`modelRouting`                           | 旧模型配置与角色路由兼容桥                                                                                             |
| `creativeJourneys`、`projectSeeds`                      | 三条创建旅程的可恢复状态，以及项目创建后归属项目的 `ProjectSeed` 输入                                                  |
| `novelSkills`                                           | 7 个 Core / 5 个 Genre 实验定义、项目显式 binding、调用前编译、精确 snapshot 与“本次参考”投影；默认全部关闭            |
| `search`、`storyGraph`                                  | 项目混合搜索和故事图派生投影                                                                                           |
| `contextTraces`                                         | 不含正文的上下文编译历史保存、列表和详情                                                                               |
| `contextTraceOutputs`                                   | AI 建议版本与精确上下文输出关联的提交边界；正式桌面版为单次 SQLite 原子提交，浏览器开发模式明确标记为补偿实现          |
| `projectKeyVault`、`projectSecurity`                    | 设备身份、项目密钥、恢复材料和生命周期                                                                                 |
| `cloudIdentity`、`cloudSession`、`cloudAccount`         | 云身份、本地会话和账户管理                                                                                             |
| `cloudSync*`                                            | 同步注册、控制、运行、冲突处理和监督                                                                                   |
| `cloudTeams`、`cloudAiUsage`                            | 团队、成员、assignment、预算和用量                                                                                     |
| `studioReview`、`studioTeamTemplates`                   | 加密团队审阅和团队模板                                                                                                 |
| `authoritativeExtraction`、`multiAgentReview`           | 权威抽取和多智能体审查                                                                                                 |
| `fineTuningGovernance`、`governedCreativeExtensions`    | 微调治理、翻译和短剧                                                                                                   |
| `marketplace`                                           | 市场目录和本地安装记录                                                                                                 |
| `credentials`、`maintenance`、`secureUpdater`           | 凭据、数据库维护和安全更新                                                                                             |
| `automaticBackup`                                       | 受限原生自动备份；浏览器开发模式为 `null`                                                                              |

页面应依赖这些端口，而不是直接拼接 SQL、读取系统凭据或绕过安全中继。

正文工作区采用全视口三栏合同，并以 `border-box` 约束页面宽度，不能让 `width: 100%` 加内边距后
再被父级 `overflow: hidden` 静默裁切。宽度大于 `1024px` 时，左栏是章节列表，中栏是正文编辑区，
右栏是 AI 创作助手；中栏优先获得可用宽度，左右栏均可收起。正文与助手之间提供 ARIA
`separator`：指针拖动限制助手为 256–560px、正文至少 320px；方向键每次调整 8px，Shift 加速到
32px，Home/End 到边界。宽度不超过 `1024px` 时不挂载 separator，正文保留为唯一主栏，章节列表改为
左侧 Drawer，AI 助手改为右侧模态面板；到 `800px` 时继续沿用单栏结构，compact drawer 的高度由
top/bottom 约束，直接操作保持至少 44px。顶部状态与操作允许换行，不能依靠隐藏横向滚动条掩盖
溢出。抽屉和模态面板仍须满足 Escape、焦点约束与关闭后的焦点返回。production Chromium 已覆盖
1536/1440/1280/1024/800、125%/150%/200% 等效视口和代表性明暗主题；真实 Tauri WebView/DPI
仍为 `NOT_VERIFIED`。

## 3. Tauri IPC 通用约定

大部分原生命令失败时返回：

```ts
interface NativeCommandError {
  code: string;
  message: string;
  retryable: boolean;
  actions: readonly string[];
  requestId: string;
}
```

SQLite bridge 使用精简错误：

```ts
interface NativeSqliteError {
  code: string;
  message: string;
  retryable: boolean;
}
```

约定：

- Rust 结构通过 camelCase JSON 与 TypeScript 交互；
- 请求结构普遍拒绝未知字段；
- command 名使用 snake_case；
- 前端不应把完整原生错误、正文、Prompt、API Key 或恢复码写入日志；
- `requestId` 用于诊断关联，不用于授权。

## 4. 运行信息与模型凭据

前端封装和页面：

- `apps/desktop/src/infrastructure/runtime.ts`
- `apps/desktop/src/pages/settings-page.tsx`

后端：`apps/desktop/src-tauri/src/lib.rs`

| Command                    | 前端参数              | 返回                               | 说明                                         |
| -------------------------- | --------------------- | ---------------------------------- | -------------------------------------------- |
| `get_runtime_info`         | 无                    | `{appVersion, os, arch, debug}`    | 前端把 `debug` 映射为 development/production |
| `get_model_secret_summary` | `{providerId}`        | `{configured,lastFour}`            | 不返回完整 API Key                           |
| `save_model_secret`        | `{providerId,secret}` | `{configured:true,lastFour}`       | 保存到 OS 凭据库                             |
| `delete_model_secret`      | `{providerId}`        | `{configured:false,lastFour:null}` | 不存在时也视为成功                           |

约束：

- `providerId` 只允许 ASCII 字母、数字、`.`、`_`、`-`，最长 128；
- secret 长度为 8–16384，不能包含首尾空格；
- 凭据服务名为 `com.inkshadow.desktop`，账户名为 `model:{providerId}`；
- API Key 不写入 SQLite、浏览器存储、日志或通知。

主要错误：`MODEL_PROVIDER_ID_INVALID`、`MODEL_SECRET_INVALID`、
`CREDENTIAL_STORE_UNAVAILABLE`。

## 5. SQLite 与备份恢复

前端封装：`packages/data/src/tauri-sqlite.ts`  
后端：`apps/desktop/src-tauri/src/native_sqlite.rs`

正式数据库固定在应用配置目录中的 `inkshadow.db`；WebView 不能指定任意数据库路径。

当前前向迁移上限为 Data `0070_multigranular_search_retrieval.sql` / Tauri `73`。
Tauri 原生版本把 70 个 Data migration 和 3 个 story-core migration 合并成一个连续序列，所以两个
编号不要求相同。`0060`–`0065` 保留 Novel Skill、付费评测、项目派发围栏与内容无关 Provider
发送边界；`0066`/Tauri `69` 追加写作体验偏好和披露 grant，`0067`/Tauri `70` 追加有界调查
run/step/finding/evidence，`0068`/Tauri `71` 让 grant 上限只统计 active 行。`0069`/Tauri `72`
为模型 step 预留 content-free invocation UUID，并让账本 INSERT 原子绑定 step/context trace；
`0070`/Tauri `73` 只为可重建搜索投影追加多粒度、父子 UTF-16 定位与 current/branch/POV/
story-time/authority/privacy 范围，旧行为 `legacy_unknown`。
启动恢复按 Provider 发送边界把 ledger/run 结清为发送前终态或 `ambiguous`，同时对账仍非终态的
task，且不自动重发。同一变更集继续复用 `0045` lease 与 Candidate/context output 原子版本围栏。
当前 172 张作者数据表进入备份恢复，另 1 张内容无关的原生项目派发租约表明确不恢复；
`consistency_investigation_steps.planned_invocation_id` 随整表复制。已登记 migration 只校验和验证、
不可改写；新结构必须继续追加更高版本。

### 5.1 连接与查询

| Command                 | 参数                          | 返回                           |
| ----------------------- | ----------------------------- | ------------------------------ |
| `native_sqlite_open`    | 无                            | `{sessionToken}`               |
| `native_sqlite_select`  | `{sessionToken,query,values}` | `Row[]`                        |
| `native_sqlite_execute` | `{sessionToken,query,values}` | `{rowsAffected,lastInsertId?}` |
| `native_sqlite_close`   | `{sessionToken}`              | `void`                         |

绑定值：

```ts
type NativeSqlValue =
  | { kind: "null" }
  | { kind: "text"; value: string }
  | { kind: "integer"; value: number }
  | { kind: "real"; value: number }
  | { kind: "blob"; value: number[] };
```

### 5.2 事务

| Command                             | 参数                                           | 返回                           |
| ----------------------------------- | ---------------------------------------------- | ------------------------------ |
| `native_sqlite_begin`               | `{sessionToken,readOnly}`                      | `{transactionToken}`           |
| `native_sqlite_transaction_select`  | `{sessionToken,transactionToken,query,values}` | `Row[]`                        |
| `native_sqlite_transaction_execute` | 同上                                           | `{rowsAffected,lastInsertId?}` |
| `native_sqlite_commit`              | `{sessionToken,transactionToken}`              | `void`                         |
| `native_sqlite_rollback`            | `{sessionToken,transactionToken}`              | `void`                         |

事务约束：

- 一个原生连接同时只能有一个活动事务；
- 只读事务禁止变更；
- 空闲超时 2 分钟，最大生命周期 15 分钟；
- 前端禁止嵌套事务，并顺序执行事务内部调用；
- 提交状态不确定或回滚失败时，前端使整个数据库会话失效。

### 5.3 文件选择与路径票据

| Command                                        | 参数                                                       | 返回                          |
| ---------------------------------------------- | ---------------------------------------------------------- | ----------------------------- |
| `native_choose_backup_destination`             | 当前有效数据库会话                                         | `{ticket}` 或 `null`          |
| `native_choose_pre_restore_backup_destination` | 当前有效数据库会话                                         | `{ticket}` 或 `null`          |
| `native_choose_restore_source`                 | 当前有效数据库会话                                         | `{ticket}` 或 `null`          |
| `native_choose_export_destination`             | 默认文件名、格式、精确 media type                          | `{ticket,fileName}` 或 `null` |
| `native_write_export_artifact`                 | 一次性目标 ticket、格式、media type、期望字节、base64 内容 | 已验证的保存回执              |

前三个数据库路径 command 返回 64 位十六进制不透明授权票据，不是文件路径。票据与数据库会话和特定操作绑定，
不能跨会话或跨用途使用，避免 WebView 获得任意文件系统路径。
导出 ticket 同样是一次性的，但它与原生对话框选定的目标、格式和 media type 绑定。写入前重验父目录与
现有目标身份，使用 no-clobber 原子安装或 Windows `ReplaceFileW`，再从磁盘回读 size 与 SHA-256。成功回执含
format、fileName、绝对 path、byteLength 和 status；取消为 0 写入，失败错误不回显目标 path。

主要错误：

- `SQLITE_BRIDGE_UNAVAILABLE`
- `SQLITE_BUSY`
- `SQLITE_DISK_FULL`
- `SQLITE_DATABASE_CORRUPT`
- `SQLITE_MIGRATION_FAILED`
- `SQLITE_MIGRATION_INTEGRITY_FAILED`
- `SQLITE_REQUEST_INVALID`
- `SQLITE_SESSION_INVALID`
- `SQLITE_TRANSACTION_ACTIVE`
- `SQLITE_TRANSACTION_INVALID`
- `SQLITE_TRANSACTION_READ_ONLY`
- `SQLITE_PATH_TICKET_INVALID`
- `SQLITE_CONNECTION_INVALIDATED`

主要上限：SQL 1 MB、最多 16000 个绑定值、绑定数据 32 MB、结果 64 MB、最多 100001 行和
512 列。

### 5.4 `ProjectSeed` 创建输入

领域合同：`packages/domain/src/entities/project-seed.ts`。三条创建入口共享同一个版本化结构：

```ts
type ProjectSeedJourneyKind = "idea" | "import" | "professional";
type ProjectSeedSource =
  "user_input" | "imported_text" | "import_analysis" | "professional_setup" | "ai_inference";
type ProjectSeedConfirmation = "confirmed" | "unconfirmed" | "skipped";

interface ProjectSeedField {
  values: readonly string[];
  source: ProjectSeedSource | null;
  confirmation: ProjectSeedConfirmation;
  origin: string | null;
  updatedAt: string;
}
```

`ProjectSeed` 固定包含 `premise`、`genre`、`tone`、`characters`、`relationships`、`world`、
`conflict`、`style`、`pov`、`boundaries`、`currentDirection`、`initialOutline` 和
`rewriteRules`。有值字段必须带来源；`skipped` 不能同时带值，所以 AI 推断不会被误写成用户确认，
主动跳过也不会被当作普通空字段。

持久化分为两个权威阶段：

- 真实项目创建前，可恢复旅程快照是权威；
- 项目创建后，通过 `ProjectSeedStore.findByProjectId()` / `saveForProject()` 保存项目自有副本；
- Tauri 使用 `ProjectSeedSqliteStore` 和前向迁移 `0039_project_seeds.sql`，按 `project_id`
  唯一保存 schema 1 JSON、修订号和时间戳；旧异步写入不能覆盖更新时间更新的记录；
- 浏览器开发使用 `inkshadow.development.project-seeds.v1`；启动回填只接收可解析、项目 ID 有效的
  一句话开书、导入和专业创建恢复记录，损坏或已删除项目的指针会被隔离；
- `project_seeds` 已纳入作者数据备份/恢复清单，并随项目删除级联清理。

`ProjectSeed` 是创建输入，不是稳定正文、正式设定或已确认 StoryFact。页面不能仅凭字段存在就把
它显示为已经由用户确认的故事事实。

一句话开书的可恢复快照同时保存三个开头槽位、作者明确选择和一次性确定性缺口计划。计划中的每个
问题至少包含稳定 `questionId`、问题文本、目的、目标 `ProjectSeed` 字段、选项、自定义回答许可、
提问原因和来源；选择开头后一次生成最多 3 个，信息充分时允许 0–2 个。`questionIndex`、历史、
跳过项和 planner version 支持恢复，但不能在没有可用且已选择的开头时伪造 `guidance` 状态。
回答仅重算并保存 `ProjectSeed`，不会追加问题、再次运行 planner 或隐式重写开头；当前不存在第 4 次
AI planner 调用。既定问题结束后只有作者明确点击，才允许一次基于全部回答的重写。

开头批次固定由 `immediate_action`、`relationship_dialogue`、`mystery_clue` 三个请求组成并发执行，
每槽保存独立 request/batch ID、状态、来源、供应商、模型和失败码。旅程 revision CAS 与当前批次
检查阻止迟到或已取消结果覆盖当前方案，迟到结果只进入可追溯历史。只有开书服务在
`MODEL_OUTPUT_TRUNCATED` 且已收到至少 160 个可见字符、供应商和模型均可确定时，才返回显式
`partial`；作者可继续补全、重新生成或明确保留。这个例外不放宽普通正文、改写或 Candidate 的
截断失败合同。

每个合法生成批次的预期 Provider 调用数精确为 3；选择开头、确定性缺口规划和逐题回答均为 0。
调用数由自动化断言，不能把选择或回答伪装为新的模型规划动作。

开书输入策略对作者自然语言统一执行 NFC，返回字段级 `CREATIVE_INPUT_INVALID` 原因；批次编排器
必须把 pre-dispatch 校验异常和每槽异步异常都持久化为该槽的失败状态。诊断只保存错误分类、阶段、
槽位、模型身份和计数，不保存原始想法、Prompt 或生成正文。

### 5.5 Story Settings JSON 与导入事务

便携格式由 `packages/import-export/src/story-settings.ts` 定义：`format` 固定为
`inkshadow.story-settings`，`schemaVersion` 当前固定为 `1`，正文载荷分为 `characters`、
`relationships`、`worldRules`、`writingPreferences` 和可选内容数组 `memories`。关系必须使用
`fromCharacterRef` 与 `toCharacterRef` 引用本文件中两个不同人物；缺端点、自指、重复人物名、
重复规则标题、未知字段、越界或无法解析的版本都会在 dry run 中给出精确 JSON 路径和修复动作。

页面按七步披露导入：选择内容、格式规则、模板与示例、选择文件、校验与预览、解决冲突、确认
导入。与现有同名人物或规则的冲突必须逐项选择合并、保留当前或新建副本；未解决冲突和阻断项
不允许提交。`StorySettingsImportService` 在提交前再次严格预检，并把规范化文件哈希、冲突决定、
现有记录 revision/version fence、正式记录、双端点关系 StoryFact、偏好、记忆和导入收据放在一个
SQLite 事务边界内；同一 operation 的安全重试幂等，任一失败不留下半导入。

收据记录新建 ID 与被更新记录的前后 revision/version。撤销会先检查这些 fence、后续正式事实、
审阅、权威提取和记忆治理引用；只要导入后有人编辑或其他记录开始依赖本次结果，就失败关闭并
保留现状。浏览器开发运行时不伪造这个 SQLite 原子导入服务。旧开书原始 JSON 人物卡和缺少双方
人物的关系由 `inspectLegacyGuidedOpeningRecords` 进入逐条 legacy repair；原值留在版本历史，
无法补出双端点时仍不创建正式关系。

### 5.6 私密章节

`0038_private_chapters.sql` 为章节增加 `privacy_mode = "standard" | "local_only"` 和独立的
`privacy_revision`；旧章节缺省为 `standard`。`CreateChapterCommand.privacyMode` 可让章节从首个
稳定版本起进入本地私密模式。后续切换使用独立 CAS：

```ts
interface SetChapterPrivacyCommand {
  chapterId: UuidV7;
  privacyMode: "standard" | "local_only";
  expectedPrivacyRevision: number;
}

interface SetChapterPrivacyOutcome {
  chapter: Chapter;
  blockedProjectionCount: number;
  removedOutboxOperationCount: number;
  acknowledgedCloudEvidenceCount: number;
}
```

隐私切换不制造正文版本，也不改变正文修订序列。切为 `local_only` 的数据库事务会关闭尚未加密的
待处理投影并移除未确认发送的加密 outbox 操作；`acknowledgedCloudEvidenceCount` 只是本地存在
云端确认回执的正向证据，0 不能证明从未上传，也不能换算成第三方副本数量。

仅发送单章的操作会把私密目标章节的 `requiredDataDestination` 固定为 `local`。可能读取全书
StoryFact、正式记录、因果关系、检索候选或其他章节资料的操作还必须取得项目级
`ProjectContextPrivacyReceipt`；只要项目仍保留任一私密章节，续写、改写、Embedding、Rerank、
规划、审稿、连续/权威提取和 What-if 都只允许已验证的回环本地模型；保留的导入分析服务若未来
重新启用也必须遵守同一限制，但当前导入 Provider 入口完全关闭。真实派发前最后
一次异步检查会重读保留章节集合、状态、当前版本、章节修订和隐私修订；不一致时以
`PROJECT_CONTEXT_PRIVACY_CHANGED` 或 `PRIVATE_CHAPTER_LOCAL_ONLY` 失败关闭并发送 0 字。
远程和回环本地的项目上下文模型调用都必须持有同一原生生命周期 lease；lease 取得时项目必须
active，且项目、章节、当前版本和隐私指纹精确匹配。原生 request future 存活期间不能把项目转为
非 active；Provider 返回后，Candidate/context output 事务还会再次核验项目与版本。迟到完成结果、
项目或版本失效及归档竞态不能提交 Candidate；用户取消时，只允许把取消前已经可见的文本保存为
`incomplete` 隔离 Candidate，绝不写正式正文。
同步物化跳过 `local_only`；项目导出默认排除私密章节及可定位的相关派生记录，只有用户显式选择
`includeLocalOnlyChapters: true` 才纳入。
这些门禁只约束 InkShadow 当前和未来的操作，不能撤回或删除此前已到达供应商或云端的内容。

### 5.7 写作体验偏好与 Provider 披露授权

Data `0066` 保存一条全局写作体验偏好与内容无关的续写披露 grant。新安装保守初始化为直接模式，
旧数据库升级初始化为专业模式；模式、本地整理授权和 revision 使用 CAS 更新。一次性本地整理授权
只允许在作者明确接受 Candidate 后处理新增 delta，不允许 Provider 派发或自动接受正文。

`WritingExperienceStore` 提供 `getOrInitialize`、`switchMode`、`authorizeDirectMode`、
`revokeDirectModeAuthorization`、`record/find/list/consume/revokeDisclosureGrant`。Data `0068` 只对
active grant 执行 128 条上限，consumed/revoked 记录仍保留审计；备份恢复复制这些权威记录但不包含
API Key。设置页已有本地整理授权撤销；固定能力探针聚焦回归实际收集 3 files / 69 tests 并通过，
该按钮只撤销直接模式的本地普通设定整理授权。普通 UI 没有逐 grant 查看/撤销/清空面板；这不是
当前 release requirement。Provider grant 仍通过精确 fingerprint 失配、同族轮换、active 128、
SQLite/Browser/备份一致性与历史审计治理。

专业/直接续写共用 `continuation-generation-disclosure.ts`。prepare 阶段为 0 Provider call，普通界面
显示连接显示名、精确模型、发送范围、local/remote 隐私、最大调用数 1、自动重试 0 与费用上限或
unknown。确认前和 Provider 边界前都复核完整 inspection/pricing/privacy/source/version fingerprint；
直接模式只可复用同一精确 fingerprint 的 active grant。价格、路线、能力、隐私或源版本漂移会在
派发前失败关闭并保持 0 dispatch。opening 聚焦链已 2 files / 79 tests 通过；Settings 固定能力探针
先前实际收集 3 files / 69 tests，最终固定文本入口又以 1 file / 55 tests 通过点击时表单/目标/
content-free authority 冻结、prepared input 持久化、生成前权威重检与四类漂移 0-call。豆包
Endpoint ID 非空时优先作为唯一有效模型，同一值进入普通披露、授权、catalog/connection 保存和
`gateway.generate`；当前 Provider dispatch surface 无剩余 P0/P1。

2026-08-20 Provider 面审计确认当前可达动作只有：编辑器续写/选区改写、故事规划、一致性调查与
单条 repair Candidate、图片生成、Model Hub 本地评测、快捷连接/Settings 固定文本 probe、结构化
probe、翻译 probe，以及由开书专项收口的 opening。Candidate 接受、普通正文检查、接受后的本地
普通设定整理和本地派生均为 0 Provider。旧检查批量 AI、无授权摘要/连续状态、translation/
short-drama governed dispatch 与普通搜索 vector/rerank 均在 production caller 前关闭；权威提取需
`authoritativeExtraction + graphRag` 双开关，Multi-Agent 默认关闭并受 guard，rerank 没有
production caller。Provider/UI ID 聚焦回归为 4 files / 22 tests PASS。

## 6. 原生模型接口

### 6.0 可选模型目录与连接返回合同（2026-08-13 当前实现）

官方文档中的模型条目是“发现候选”，不是已连接目录、能力证据或路由。当前
`model_catalog_entries` 继续只保存某个真实 connection 同步/确认的账户目录，不接受未连接候选混入。
`selectable-model-catalog-registry.ts` 提供独立版本化 registry，保存 `providerKind`、精确 model ID
（产品族发现方向可为 null）、展示名、22 项任务类别、能力类别、生命周期、支持状态、受控
aliases/replacement 和带失效时间的官方来源。普通投影移除官方 URL、更新时间与 TTL；专家投影才保留。
浏览地区只用于分组，不能冒充数据落点或隐私证明。所有官方条目固定为 `routable=false`、
`capabilityEvidence=false`；只有真实账户目录及随后保存的能力证据能参与路由。

`model-hub-connection-intent.ts` 只把内容无关的 UI 导航意图写入 localStorage：schema version、任务、
供应商、精确型号、registry 版本、创建时间和失效时间；TTL 为 30 分钟。它没有作品内容、return target、
旧路由指纹、route revision、凭据或业务状态，不是 Model Hub/路由的 source of truth。未知字段、损坏
JSON、过期或 registry 版本变化都会 fail closed 并清除。账户真实目录出现 exact ID/受控 alias 但
任务能力证据不足时仍停留在 Model Center；只有形成该任务的可信或待探针推荐后，页面才展开两层任务
披露并聚焦原任务。能力探针不会自动创建初始智能路由，最终保存仍要求用户显式操作并执行已有路由
CAS。取消会清除
intent，缺失型号可显示真实账户目录供手动选择但不能自动替换。`ModelHubSelectableCatalogBrowser`
默认折叠并延迟挂载列表，全局和 22 项任务入口均保持账户目录优先；选择全局已连接型号也不会自动
分工。Browser 自动化已覆盖这条返回链，真实 Windows Tauri + Keyring 返回仍为 `NOT_VERIFIED`。

Agent 层不新增第二套执行总线。当前结论是确定性轻编排：route → privacy/cost preflight →
context/Skill snapshot → exact dispatch → isolated Candidate → explicit acceptance。未来任何模型驱动
orchestrator 只能是专家可选、有限步骤/调用/费用/时间、可取消并逐步留收据；不得拥有正文、版本、
StoryFact、凭据、备份或商业授权写权限。

前端：

- `apps/desktop/src/infrastructure/runtime.ts`
- `apps/desktop/src/infrastructure/native-embedding-gateway.ts`
- `apps/desktop/src/infrastructure/native-rerank-gateway.ts`
- `apps/desktop/src/infrastructure/native-image-generation-gateway.ts`
- `apps/desktop/src/pages/settings-page.tsx`

后端：

- `apps/desktop/src-tauri/src/model_gateway/gateway.rs`
- `apps/desktop/src-tauri/src/model_gateway/types.rs`
- `apps/desktop/src-tauri/src/system_capacity.rs`

通用配置：

```ts
interface NativeGatewayEndpointConfig {
  providerId: string;
  provider: "open_ai_compatible" | "ollama" | "anthropic" | "gemini";
  baseUrl: string;
  authentication: "none" | "bearer_keyring" | "custom_header_keyring";
  modelDiscoveryPath?: string | null;
  textGenerationPath?: string | null;
  embeddingPath?: string | null;
  credentialHeaderName?: string | null;
  requestTimeoutMs?: number;
  retryLimit?: number;
}
```

| Command                           | 参数                                                                                         | 返回                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `list_native_models`              | `{request:{config}}`                                                                         | `{provider,models:[{id,displayName,sizeBytes?}]}`   |
| `check_native_model_connection`   | `{request:{config}}`                                                                         | `{provider,endpointOrigin,modelCount,latencyMs}`    |
| `inspect_native_model_capacity`   | 无                                                                                           | CPU、内存、应用盘和 GPU 容量                        |
| `embed_native_model`              | `{request:{config,model,inputs}}`                                                            | provider、origin、model、dimension、向量            |
| `rerank_native_model`             | `{request:{config,protocol,model,query,documents,topN}}`                                     | provider、protocol、origin、model、排名和输入 Token |
| `choose_native_image_destination` | 无                                                                                           | 五分钟单次文件票据或 `null`                         |
| `generate_native_image_to_file`   | `{request:{destinationTicket,config,model,prompt}}`                                          | 安全保存后的 PNG 元数据                             |
| `start_native_generation`         | `{request:{generationId,config,model,messages,maxOutputTokens,temperature?,reasoningMode?}}` | `{generationId,accepted}`                           |
| `cancel_native_generation`        | `{request:{generationId}}`                                                                   | `{generationId,cancellationRequested}`              |

原生请求路径：

| 提供方            | 模型列表                                    | 生成                                                  | Embedding                              |
| ----------------- | ------------------------------------------- | ----------------------------------------------------- | -------------------------------------- |
| OpenAI-compatible | `GET {baseUrl}/models` 或已验证专家相对路径 | `POST {baseUrl}/chat/completions` 或专家相对路径，SSE | `POST {baseUrl}/embeddings` 或专家路径 |
| Ollama            | `GET {baseUrl}/api/tags`                    | `POST {baseUrl}/api/chat`，NDJSON                     | `POST {baseUrl}/api/embed`             |
| Anthropic         | 官方模型目录                                | 官方 Messages SSE                                     | 当前不宣称 Embedding                   |
| Gemini            | 官方模型目录                                | 官方流式内容生成                                      | 官方批量 Embedding                     |

完整 Model Hub 的 Provider Registry 当前覆盖 OpenAI、DeepSeek、阿里云百炼/Qwen、火山方舟/豆包、
Google Gemini、Anthropic Claude、智谱 GLM、Ollama 和自定义 OpenAI-compatible。普通模式隐藏不必要
的底层参数；开书快捷连接显示其中 DeepSeek、OpenAI、百炼/Qwen、豆包、Ollama、GLM 和自定义兼容。
百炼、豆包、GLM 或自定义连接无法可靠自动列出账号实际可用模型时，用户必须明确填写模型/Endpoint，
再运行不含作品内容的真实文本探针；系统不得仅根据模型名标记能力。

官方 Provider metadata fallback 只在精确匹配官方 DeepSeek endpoint 与 `deepseek-v4-flash` /
`deepseek-v4-pro` 时生效；当前资料有效期为 2026-08-10 至 2026-09-10，声明 1,000,000 token
context、384,000 token output 及官方结构/思考资料，但始终标记 `verifiedByInkShadow=false`。真实
目录字段优先，自定义端点不继承 fallback。DeepSeek 的可见正文仍禁用思考输出，不把
`reasoning_content` 当作 Candidate。

文本能力探针统一使用固定无作品内容消息和 `64` token 输出预算。Provider Registry 只为 DeepSeek
探针声明 `reasoningMode = "disabled"`，原生 OpenAI-compatible 请求映射为
`thinking: {"type":"disabled"}`；其他供应商不会收到该专有参数。设置页、快捷连接的手动/已配置
连接检查和本地基础评测复用这项策略。它只证明模型能输出可见文本，不证明文笔、结构化输出或
其他能力，也不按模型名称猜测支持项。
Settings 两个固定文本 probe 均披露当前 destination、retry0、cost unknown，并在点击时冻结表单、
精确目标与 content-free SHA-256 authority；同一 prepared input 持久化后，在
`gateway.generate` 前复核表单、fingerprint 与 authoritative identity。四类漂移为 0 call，成功
精确 1 call；固定短句不发送作品正文、灵感或设定。豆包 Endpoint ID 非空时作为同一有效模型贯穿
披露、授权、保存和派发，双字段不一致不能再确认 A 发送 B。

供应商预设与能力资料会变化，Registry 应按官方接口/地域说明更新，而不是把某个模型写成永久
最佳： [OpenAI models](https://platform.openai.com/docs/api-reference/models/object)、
[DeepSeek `/models`](https://api-docs.deepseek.com/api/list-models)、
[DeepSeek Base URL](https://api-docs.deepseek.com/quick_start/pricing)、
[百炼地域与 Workspace](https://help.aliyun.com/zh/model-studio/regions/)、
[Gemini models](https://ai.google.dev/api/models)、
[Claude models](https://platform.claude.com/docs/en/api/models/list)、
[Ollama API](https://docs.ollama.com/api/introduction)、
[GLM OpenAI-compatible](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)。

Provider recommendation registry 只提供带版本和有效期的发现方向，不创建连接、目录、能力证据
或路由。当前可提示阿里云 `text-embedding-v4` / `qwen3-rerank` 与火山 Seedream 资料；真正的任务
推荐只对已经连接、目录可见且具有相应证据的条目排序。OpenAI-compatible 的结构化输出可运行固定
严格 schema 探针；翻译只在固定无作品内容的 `inkshadow.translation-probe.zh-en.v2` 成功后保存
translation 能力和路由。文档声明或模型名称本身都不是能力证明。

远程 Rerank 底层保留独立、窄范围协议，但当前没有 production caller，普通搜索固定使用本地 FTS。
未来若重新开放，只允许 Model Hub 已确认的阿里云百炼北京地域 Qwen OpenAI-compatible
`/reranks`，并要求显式远程内容同意、ready 连接、Workspace、OS 凭据库中的 API Key、有效
`rerank` 能力证据、已确认隐私/保留/训练政策和可核验费用上限；否则继续使用本地确定性排序。
尚未用真实 Qwen 凭据完成线上端到端，也不得把底层协议外推为当前或其他供应商可用。

图片生成当前只接受受限的 OpenAI-compatible base64 PNG，并通过原生单次文件票据安全另存；
不会自动下载模型返回 URL、插入正文或写入素材库。

网络规则：

- 远程地址必须使用 HTTPS；
- HTTP 只允许显式 loopback；
- URL 不能包含用户名、密码、查询、fragment 或危险路径；
- 拒绝私网、链路本地 IP 字面量；
- Bearer Key 只从 OS 凭据库读取；
- 不自动跟随重定向；
- 所有请求由 Rust 发出。

主要上限：

- 最多 256 条消息；
- 输入正文总量 1 MB；
- 最大输出 32768 token；
- Embedding 每批最多 64 条，总输入 512 KB；
- Rerank 最多 64 条候选，查询、单条和总字节均有限制；远程失败不会清空本地候选；
- 单个事件 delta 最大 64 KB；
- 原生生成总超时 10 分钟，前端保护超时 620 秒。

主要错误包括：`MODEL_ENDPOINT_INVALID`、`MODEL_CREDENTIAL_MISSING`、
`MODEL_REQUEST_INVALID`、`MODEL_INPUT_LIMIT_EXCEEDED`、`MODEL_OUTPUT_LIMIT_EXCEEDED`、
`MODEL_RESPONSE_INVALID`、`MODEL_RESPONSE_LIMIT_EXCEEDED`、`MODEL_STREAM_TRUNCATED`、
`MODEL_OUTPUT_TRUNCATED`、`MODEL_TIMEOUT`、`MODEL_CONNECTION_FAILED`、`MODEL_GENERATION_DUPLICATE`、
`MODEL_EVENT_EMIT_FAILED`、`MODEL_HTTP_UNAUTHORIZED`、`MODEL_HTTP_FORBIDDEN`、
`MODEL_HTTP_NOT_FOUND`、`MODEL_HTTP_RATE_LIMITED` 和 `MODEL_HTTP_PROVIDER_UNAVAILABLE`。

原生解析器不会把 `reasoning_content` 当成用户可见正文增量。它只为失败诊断保留是否出现和
有界长度，并在同一帧先交付可见 `content`/usage，再处理 `finish_reason`。普通正文、改写和
Candidate 生成遇到截断仍严格失败；只有固定、无作品内容的能力探针可以在已收到非空可见文本时
把截断记录为 `partial` 并提交文本生成证据。只有推理或空响应仍失败。

### 6.1 Model Hub 与小说智能前端服务

模型选择的唯一权威链应为：

```text
Provider Connection
→ Model Catalog Entry
→ Capability Evidence
→ Task Route
→ Resolved Invocation Route
→ Model Invocation
```

页面 readiness、生成前检查和真实调用必须读取同一份 `Resolved Invocation Route`；连接行、目录名、
HTTP 200、旧 Model Profile 或顶部绿色徽标都不能单独证明可调用。下表是
**2026-08-13 历史审计快照**，只用于解释迁移来源；它不代表 2026-08-20 工作树中这些入口仍然
可达，也不能把旧路径冒充当前完成状态：

| 入口                                         | 审计时来源                                              | 处理策略                                                                                            |
| -------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 开书三个方案                                 | 项目内 Model Hub；非项目兼容路径仍可落旧配置            | 项目内保持 Model Hub fail closed；旧配置只作明确兼容，不得绕过已存在但失败的任务路由                |
| 正文续写                                     | Model Hub + 旧 Model Profile 混合；计划阶段旧配置先执行 | 改为 Model Hub exact resolver 优先；仅 `MODEL_HUB_ROUTE_NOT_CONFIGURED` 才检查旧兼容配置            |
| 选区改写、检查、剧情试演、章节摘要、连续状态 | 已使用 Model Hub text task 服务                         | 保留统一 resolver、最终身份复核与 Candidate/StoryFact 边界                                          |
| 导入改写                                     | Model Hub-first，路由不存在时旧配置兼容                 | 保留窄兼容，其他 Model Hub blocker 不得降级                                                         |
| Multi-Agent、原生受治理扩展、权威提取        | 仍有直接原生/旧配置适配器                               | 本轮记录为待逐入口迁移；继续受 feature flag、隐私、预算、Candidate 与最终身份门禁约束，不一次性删除 |

当前状态以本文件后续服务表和
[`WRITING_EXPERIENCE_AND_CONSISTENCY.md`](WRITING_EXPERIENCE_AND_CONSISTENCY.md#provider-动作的普通界面披露)
为准：开书、续写、Settings 固定能力探针、图片生成、调查/修复已有聚焦披露证据；旧导入、普通
检查批量 AI review、无授权摘要/连续状态和普通搜索向量入口已安全关闭。Provider dispatch surface
当前无剩余 P0/P1；冻结全量仍为 `PENDING_FINAL_RUN`，不得从历史快照外推为已验证。

旧 Model Profile 仍可能包含历史用户配置，因此本轮不删除表、不伪造 selection、不搬移 Key，也不
改写已发布迁移。有效 Model Hub task route 存在时运行时忽略未选择的旧档案；真正没有 task route
时才允许明确标注 `legacy_compatibility` 的兼容解析。若 readiness 认为 task 可用而 exact resolver
无法得到同一身份，应返回 `ROUTE_RESOLUTION_INCONSISTENT` 并留下脱敏决议记录，而不是回退为
`MODEL_PROFILE_NOT_READY`。

普通模式提供连接、测试、模型同步/确认，以及智能推荐、高质量、经济模式、本地隐私和完全自定义
五种方案。专家模式才显示受限 Base URL/路径/Header 元数据、超时/重试、能力证据、逐任务主备、
费用与隐私策略。API Key 值不会回传页面。连接恢复语义必须区分：

- “删除凭据”只清除系统凭据并停止新调用，保留原连接 ID、目录和历史审计；用户可对该精确连接做 revision CAS 重新绑定，无需手改 ID；
- “暂时停用”保留凭据与可恢复连接，但不能进入 ready 或普通路由；
- “退役连接”保留被历史 invocation 引用的行，但从普通选择、推荐、全局 ready 和路由候选中永久排除。同供应商新建使用自动分配的新 ID，不与退役行冲突。

重新绑定与退役使用事务/revision 约束，并发操作只有一个确定胜者。路由始终绑定精确的 active
connection/catalog entry，同模型的退役重复项不能被意外选中。

设置页首次进入和连接切换由单一权威 hydration 快照驱动。它按“连接 → 持久化正文路由选择 →
系统凭据摘要 → 本地目录/能力/路由”恢复页面；每次操作携带 generation，较慢旧请求不能覆盖新选择。
无连接保持“未配置”，只有明确 `authenticationMode=none` 的已保存连接标为无需密钥。目录重新发现
失败会保留缓存并给出重试原因；非凭据阶段故障不会污染系统凭据状态。

Model Hub 普通状态的视觉语义固定为：`loading` 使用单一读取进度；`unconnected` 使用中性连接引导，
并明确手动写作仍可用；`connected` 显示账户真实目录与可执行任务；`partially_available` 只在相关
能力旁显示缺口；`error` 只用于用户已经执行的保存、发现、验证或路由动作失败。未连接时不能同时
渲染保存、发现、验证三个 warning。官方候选目录默认折叠，并与账户目录、能力证据和任务路由分开。

顶栏、作品库、Model Hub 和任务推荐共用无正文的权威基础 readiness 投影。它复用真实派发的
connection、catalog entry、Provider/model、capability evidence、credential summary、route/revision 和费用
resolver，但不含当前章节隐私、编译后上下文和本次 request profile，因此全局只显示“AI 基础连接可用”
或“基础配置检查 10/10”，不再显示“AI 写作已就绪”。当前章节的真实 preflight 在派发前复用同一
resolver 并加上内容级检查。失败会把当前作品顶栏覆盖为“当前续写需修复”，指出受影响任务、原因和修复入口，
并明确正文、不可变版本和 Candidate 未改变。确定性 preflight 失败不创建 invocation、Candidate 或费用记录，
也不通过重试隐藏。

受影响页面使用现有 DESIGN token：普通内容容器遵循页面既有最大宽度；Card 内容至少使用
`--space-4`，Input、Textarea、Select 的内边距至少使用 `--space-3`；标题、说明和动作保持 token
间距。普通空状态低于 warning/error 的视觉权重。目录长模型名允许换行，800px 与 200% 等效窄屏
下操作按钮改为整行可达；验收宽度为 1440、1280、1024、800 和 200% zoom，不能用隐藏 overflow
冒充适配。

首次文本能力验证成功且当前完全没有任何任务路由记录时，智能推荐可建立 16 类只依赖
`text_generation` 的核心小说任务分工；旧版本留下的纯自动、同方案 15/22 中断计划可幂等补齐。
整个 preset 与任务路由集合由一次原子提交替换，任一写入失败都保留完整旧方案；任一用户建立的
启用、禁用或自定义路由都不会被覆盖。价格、上下文长度和本地基础评测属于可选排序证据，缺失时
不阻止已有文本能力证据的核心分工。22 类总任务中的结构化输出、Embedding、Rerank、图片、视觉
等仍必须等待各自证据。基础评测只执行已持久化路由，不能替代
能力发现。诊断 artifact schema v3 从能力扫描和调用事实账本读取最近脱敏 AI 失败，包括 request
ID、阶段、HTTP/终止原因、可见长度、推理/流式标记、尝试和 token 预算；不包含 Prompt、作品、
模型回答、推理正文、供应商原始错误或凭据。旧 `modelCenter` 兼容指标明确命名为
`legacyModelProfileCount` / `legacyModelProfilesWithSelection`；Model Hub 另行报告
`modelHubConnectionCount`、`modelHubUsableConnectionCount`、`modelHubCatalogEntryCount` 和
`modelHubEnabledTaskRouteCount`，并记录脱敏的 UI hydration 快照、最近操作及当前会话/历史错误码。
可用连接只表示已启用且状态为 ready/degraded，不替代能力证据。

以下服务运行在 Desktop runtime 内，通过页面调用，不是 Cloud API：

| 服务/存储                                                               | 用户入口与合同                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ContinuousStoryStateExtractionService`                                 | 底层模型服务保留，但当前生产入口不可派发：手动保存、Candidate 接受、导入、版本恢复和历史回填只运行本地派生；逐章重识别按钮在独立逐次授权、精确 Provider/model 披露、持久发送边界和 ambiguous 防重发完整前保持禁用。已有结果仍为可撤销或待确认 StoryFact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ContinuousStoryStateProjectionAdapter`                                 | 无独立按钮；只读地把显式合法投影交给验证、声纹/POV 和叙事分析；POV 取得链同时核验人物、知识键、信息标识、取得时间、已确认事件、来源事实和叙事顺序，任一证据、分支、当前性或权威门禁失败即跳过并返回诊断                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `NovelSkillRuntime` / `NovelSkillPanel`                                 | “设定 → 写作方法（实验）”；内置 7 Core + 5 Genre 全部 `EXPERIMENTAL`、默认关闭。ProjectSeed 只生成 recommendation，只有作者显式开关才写项目 binding。开书与续写在 dispatch 前编译有界 `<novel_method>` 并把 exact snapshot 绑定到同一 trace/generation/model invocation；浏览器开发模式明确不可用且不生成伪回执                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `NovelSkillPaidEvaluationCoordinator` / `NovelSkillPaidEvaluationPanel` | “设置 → Model Hub → 模型评测”的专家折叠区；固定 12 × 4 × 2 × 2 的 192-cell 计划，只接受两个已连接、已验证且价格完整的精确目录目标。挂载、准备、报价、授权和重启恢复都不会调用模型；商业确认与“手动开始 192 次付费调用”是两个动作，只有后者可进入无 fallback、无自动 retry 的串行 exact-target 派发。取消或崩溃越过发送边界后整次 run 标为歧义并禁止自动重发。盲评只显示随机题号、任务、边界、锁定事实、期望结果与隔离 Candidate，不显示 arm、模型、槽位、重复、成本或持久化哈希；13 项人工分必须全部填写。当前真实调用与人工评分仍为 `NOT_RUN`，所有 Skill 继续默认关闭                                                                                                                                                                      |
| `parseNaturalLanguageSetting` / `StorySettingsImportService`            | “设定 → 快速维护故事设定”；自然语言只形成待确认候选，关系必须解析出两个不同人物端点。Story Settings JSON 先严格 dry run，再逐项解决冲突并用单事务提交正式记录、StoryFact、偏好、记忆和收据；撤销受 revision/version fence 与后续引用保护，旧开书坏记录另走逐条 repair                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `CausalFactAuthoringService` / `CausalFactAuthoringPanel`               | “设定 → 高级工具 → 故事关联”；事件可填写前置条件、人物状态、关系、物品和伏笔变化，并展开“明确获得的知识”。人物只从当前作品中主分支、正式、用户确认且仍有效且实体键唯一的人物身份中选择；两个有效人物共享同一实体键时失败关闭。正式事实插入会在同一事务精确复核有效来源章节、当前不可变版本、证据片段、事实类型与 schema、关系端点、前置事件和全部人物引用；保存瞬间任一权限失效都会失败关闭，相同重试返回原事实而不重复。正式事实已保存但派生图或页面刷新失败时会明确显示“已保存、等待刷新”，不会谎报未保存。空列表允许保存但不会授权 POV 取得，服务不会从事件正文或知情人物自动猜测；参与者和知情者各最多 128 个，明确知识最多 128 条，结构化事实超过 16 KiB 时会在保存前提示拆成两个事件。动态字段提供上限播报、新增焦点和删除后的焦点返回 |
| `StoryFactApplicationService.resolveEntityAlias`                        | “设定 → 待确认内容”；只能从候选允许列表选择已有对象，或明确保留独立对象；CAS 防并发覆盖，畸形候选结构失败关闭并要求废弃、重新识别或手动新建                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ChapterSummaryService`                                                 | 底层摘要读取与清除合同保留，但当前生产入口不可派发 `long_memory_compression`：手动保存和所有 accepted-version 后台任务只运行本地阶段，逐章云端重建按钮保持禁用。既有摘要仍绑定精确当前不可变版本与内容哈希；过期或校验失败摘要从上下文排除，历史 `plain_non_authoritative` 摘要绝不提升为 StoryFact                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `MemoryService.forgetProjectMemory` / `mergeRecords`                    | 设置页按明确项目执行记忆忘却：同一事务关闭自动学习并排除全部现有记录；设定页人工选择两条记忆、编辑合并内容、指定保留项并排除来源项。两种操作都需要人工确认、修订校验和不可变审计，不按相似度自动合并，不物理删除来源                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ContextCompilationTraceStore`                                          | “设定 → AI 参考记录”；保存、按项目列最近 50 次、按 ID 展开并按最终 AI 建议版本精确反查。普通详情显示可读来源、采用/舍弃原因、origin 和预算；有精确 Novel Skill snapshot 时另显示方法名称、版本、采用/舍弃原因和独立预算，缺失回执不冒充已使用。记录只关联真实网关生成、Model Hub 调用事实和隔离 Candidate，不保存正文、Prompt、摘录、模型回复或向量；编译器输入条目标识名为 `contextCandidateId`，不是 AI Candidate ID                                                                                                                                                                                                                                                                                                                       |
| `TaskOutputProfile` / continuation recovery                             | 续写短档为 800/1,000/1,200、标准档为 1,800/2,200/2,500、长档为 3,000/4,000/5,000 个最小/目标/最大可见字符，自定义目标限制 200–12,000；context economy/standard/long 上限为 12k/32k/64k token，并按模型窗口、输出、系统/协议开销和保守 CJK 估算再收紧。截断或取消后的可见正文只能保存为 `incomplete` 隔离 Candidate；边界安全预览可以省略末尾残句，但持久化 Candidate 完整保留供应商已返回的可见文本。继续补全固定原基线版本，以原始尾部作为 assistant 上下文并去除安全重叠；末句未完成时直接接写，不强插段落。作者也可保留比较、重生成或换模型，任何路径都不自动覆盖正文                                                                                                                                                                     |
| `AmbiguousNovelReviewService`                                           | 保留旧语义矛盾、POV、人物声纹和内容质量的 service/历史兼容合同，但普通检查页的新批量 Provider 入口已安全关闭；配置 route/credential 不会使其可达。需要模型的当前用户链是另行精确披露、确认和记账的有界一致性调查                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ConsistencyInvestigationService` / `ConsistencyInvestigationPanel`     | “检查 → 长篇一致性调查”；准备为 0 call。发送前显示本机/远程、连接显示名、精确模型、发送范围、1 call/0 retry 与费用上限或“未知；提供方可能计费”。确认 fingerprint 覆盖完整 inspection authority、全部 capability evidence、connection display、隐私、context/messages，并在确认后与最终 dispatch 前重读；route、价格、目的地、能力、正文或 EvidenceRef 漂移均 0 Provider。内部记录 `INVESTIGATION_DISCLOSURE_CHANGED`，普通界面只提示“本次发送 0 字，请重新查看范围与费用”                                                                                                                                                                                                                                                                    |
| `ConsistencyRepairCandidateService`                                     | finding 修复是调查之外的第二次独立 Provider 动作，不能复用调查授权；重复同样披露和双重 fingerprint 复核。合法响应只形成一处补丁并本地合成为隔离 Candidate，作者仍须在编辑器显式接受才创建新不可变版本；取消、无效输出、known failure、ambiguous 或重启都不自动重发。调查/修复披露聚焦 2 files / 36 tests PASS，真实 Provider/Tauri 未跑                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ModelHubStoryPlanningService` / `StoryPlanningCandidateStore`          | “规划”；全书方向或章节场景拆解，严格 JSON，先存独立可编辑候选；可整体采纳，或按生成时目标简介基线逐项追加固定结构化条目。逐项采纳会先用候选 revision CAS 持久预留选择和前后摘要，再写正式大纲；在途状态禁用编辑、拒绝和整体采纳，只允许恢复同一选择。空选择、未知条目、旧候选无基线、损坏回执和并发变化均失败关闭                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `createSelectionRewriteCandidate`                                       | 编辑器“修改选中内容”；固定当前不可变版本、UTF-16 选区和原文 SHA-256，复用 `rewrite` 路由与上下文编译器；发送前后防漂移，只把改写片段连同 `selection_rewrite / replace_selection` 精确锚点保存为 `polish` Candidate，并可由该 Candidate 精确反查实际上下文 trace 与 Model Hub 调用；项目保留任一 `local_only` 章节时，远程生成和远程重排均为 0 调用，已验证回环本地模型仍可执行                                                                                                                                                                                                                                                                                                                                                               |
| `ReviseAiCandidate` / `AcceptAiCandidate` / `RejectAiCandidate`         | 编辑器建议比较；作者修改可先持久保存为仍隔离的 `ready` Candidate。命令必须携带页面实际展示的 Candidate revision，存储事务再以状态 + revision 做 CAS，不能在执行前重读最新版冒充用户已看过。接受时先复核 Candidate 内容 SHA-256，再读取任务应用意图：续写片段只插入记录光标，选区片段只替换记录范围；整章改写只允许覆盖全文或在当前与基线共同末尾追加。Candidate/context output 事务还复核项目 active、章节 active、当前版本、Candidate 基线和 context source version；正文、新版本和 Candidate 决定在同一事务中提交，失败或迟到结果不改变正文或赢家建议。接受后只登记搜索/因果等纯本地可重建阶段，精确 0 次 Provider 调用；摘要、记忆和事实抽取只能从接受完成后的独立显式授权动作进入                                                        |
| `HistoricalChapterBackfillService`                                      | 章节整理高级区域；先生成零写入只读计划，再经明确确认按登记前核验的当前稳定版本、阶段规则 v2 幂等登记缺失工作；首次写入前过期为零写入 `stale`，中途过期为保留已登记计数的 `partial`，相同权威任务并发落地计入 `alreadyRegistered`；复核后竞态产生的旧任务由执行前版本/隐私门禁在模型发送前以永久“不适用”结清；旧成功任务兼容，disabled→enabled 只补对应阶段，终态失败按阶段和代数恢复；worker 每轮最多处理 5 个历史回填任务                                                                                                                                                                                                                                                                                                                   |
| `ChapterValidationSnapshotStore`                                        | “检查”；把确定性检查结果、证据摘要和规则版本绑定到不可变章节版本；正文版本变化后旧快照只作历史证据，不冒充当前结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `NovelValidationRuntime`                                                | “检查”；逐类记录 `checked` / `not_checked`，证据不足不会显示为通过。声纹、POV、多线、伏笔和节奏提醒的忽略/允许/撤销必须由运行时可信重算当前不可变版本的 finding 与完整证据签名，并通过存储层版本 fence、revision CAS 和幂等提交；页面字符串本身不构成处置权限                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `WritingFeedbackLearningService` / `WritingFeedbackStore`               | 明确反馈最多 500 字；项目级幂等身份只持久化 SHA-256。SQLite 用单事务、浏览器用单 storage mutation 同时固定事件时学习策略、插入事件、按全部合格事件计数并同步可见偏好；重复提交不增加事件、证据或偏好 revision。导入规则已经形成但反馈保存失败时显示可重试的部分成功状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ProjectContextPrivacyAuthority`                                        | 无独立按钮；为项目仍保留的章节状态、当前版本、章节/隐私修订和隐私模式生成不含正文的指纹。任一仅本机章节会把全书上下文 AI 限制为已验证本地模型，真实派发前指纹变化则在 0 字发送处停止                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `evaluateGeneratedCandidateQuality`                                     | 编辑器生成完成后只检查本机可证明的句段重复；不伪造文笔、一致性、POV 或声纹分数                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `connectQuickModelProvider` / `configureQuickBookStartRoute`            | 开书页快捷连接：DeepSeek、OpenAI、百炼/Qwen、豆包、Ollama、GLM 和自定义兼容；staging 凭据验证、真实目录或明确模型/Endpoint 的固定文本探测、隐私证据和仅 `book_start_guidance` 路由；失败不覆盖旧 Key，也不改写其他任务分工；多个自定义连接使用独立 ID 与凭据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

这些模型服务都依赖用户自己的 Model Hub 连接、能力证据、路由和凭据。页面与测试存在只证明
调用合同和失败关闭，不代表真实云端供应商或长篇性能已经验收。

### 6.2 已接受正文的后台整理与立即重试

`apps/desktop/src/infrastructure/accepted-chapter-pipeline.ts` 在候选采纳、章节导入、版本恢复或
用户明确手动保存的不可变正文版本已经提交后运行。任务类型是 `story.accepted-version.process`，幂等键是
`story.accepted-version:<versionId>`，输入只接受有效项目、章节、版本 ID、来源和非负安全整数
字符数。

任务元数据仍保留四阶段兼容形状，但当前生产执行会在任务创建、直接执行、人工重试和 worker 启动恢复时
把两个 Provider 阶段强制归一为关闭。一次执行只运行：

1. 重建本地项目搜索索引；
2. 重建因果事件投影。

本地阶段独立产生 `completed`、`skipped`、`not_applicable`、`partially_completed` 或 `failed` 回执。
索引或投影失败不会回滚或改写已接受正文；重试也只重试本地范围。旧任务元数据中的
`runChapterSummary=true` / `runStoryState=true` 仅作为历史审计保留，不会恢复云端派发。

成功任务以规范 `pipeline.outcome.search-summary-state-causal` 子集写入持久 progress，只有列出的阶段
才有完成证据。旧 `succeeded` 任务没有 outcome 时只保守承认本地搜索与因果阶段；摘要和连续故事
状态不再作为当前后台任务的待补阶段。

含终态的成功任务使用 `pipeline.outcome.v2.<stage>-<c|n|d>`：`c` 表示完成，`n` 表示对绑定的
不可变版本永久不适用，`d` 表示等待未来显式重规划。空章节、来源过大、来源/隐私已变化、绑定版本
不存在均为 `n`，不会自动重试或为同一版本升代。当前回填计划固定 Provider 上限为 0；旧 Provider-only
补充任务到期时被取消，不会进入发送或自动重试。

历史补缺任务可额外携带 `runSearch`、`runChapterSummary`、`runStoryState`、
`runCausalProjection`、`pipelineStage`、`pipelineStageRuleVersion`、
`pipelineStageGeneration` 与完整 `pipelineIdempotencyKey`。首个版本任务仍使用原键；阶段补充键为
`story.accepted-version:<versionId>:backfill:v2:<stage>:<generation>`。worker 必须校验键和元数据一致，
同一任务等待重试时从 `failure.causeCode` 的阶段掩码收窄执行范围。重试耗尽会保留该具体原因，
供后续只补失败的本地阶段。新任务的两个 Provider flags 必须显式为 `false`；旧值为 `true` 或缺失时，
worker 也只生成本地执行输入。掩码必须使用规范顺序且只能包含任务启用阶段；补充任务必须绑定
`historical_backfill`、规范键、版本/阶段/代数和 one-hot `runX`。未知、重复、乱序、越界或非布尔
元数据全部失败关闭；四个 `runX` 全为 `false` 的空范围任务在登记、直接执行和 worker 恢复三处也
失败关闭，不生成空 outcome。该机制复用现有任务表，不引入迁移。

若同轮同时有可重试失败与终态/延期，`failure.causeCode` 使用紧凑规范 v2 证据同时保存三组处置，
避免任务失败转换清空普通 progress 后丢失终态。重试耗尽时历史回填优先读取该证据：完成和永久不适用
算覆盖，延期仍算缺失；只有没有 v2 证据的旧失败任务才按旧失败掩码保守推断。

任务中心的“立即重试后台整理”不是通用重放按钮，也绝不会恢复 Provider 阶段。它只对以下任务显示：类型匹配、状态为
`waiting_retry`、失败声明 `retryable` 且包含 `RETRY`，并且项目/章节/版本 UUID、来源
（`candidate_accept`、`chapter_import`、`manual_save`、`version_restore` 或 `historical_backfill`）及字符数元数据全部有效。页面先调用
`taskCenter.retryTaskNow(task.id)`，再以原版本作用域执行同一幂等管线；不完整元数据会失败关闭。
通知 metadata 只从显式白名单生成普通文案；project/chapter/version/connection/debug ID 不显示，但
经过验证的导航目标继续可用。未知任务进度码使用安全占位，不把 raw code 当作标签。

### 6.3 个人调用账本

`UsageCenterReader.read(query)` 是 `/usage` 的只读端口。查询可按时间范围、项目、小说任务、
供应商和模型过滤，返回汇总、最多一批明细、各维度分组、可用筛选项和预算政策。明细来源只
包括本地 `generation_attempt` 与 `model_hub_invocation` 记录，保存任务、模型、状态、token、
数据目的地、错误码及可确认的费用元数据，不保存正文、Prompt 或 API Key。金额缺少价格或
token 证据时保持“未知”，不会冒充供应商最终账单。浏览器开发运行时把 `usageCenter` 设为
`null`，页面显示能力受限而不是生成示例账本。
连接资料缺失时只显示安全的供应商占位，不回退 `provider_id`。检查页同样把章节、剧情线和场景
映射为可读名称；人物、伏笔或未知引用使用安全占位，不显示 version/fact/locator/aria 内部标识。
这些普通 UI 边界已由 4 files / 22 tests 聚焦覆盖，冻结全路由 DOM 扫描仍待运行。

## 7. Tauri 事件

### 7.1 `model-generation-event`

监听：`apps/desktop/src/infrastructure/runtime.ts`  
发送：`apps/desktop/src-tauri/src/model_gateway/gateway.rs`

```ts
interface NativeGenerationEvent {
  generationId: string;
  sequence: number;
  delta: string;
  status:
    | { phase: "started" }
    | { phase: "delta" }
    | {
        phase: "completed";
        usage: {
          inputTokens: number;
          outputTokens: number;
          cachedInputTokens: number | null;
        } | null;
      }
    | { phase: "cancelled" }
    | { phase: "failed"; code: string; retryable: boolean };
}
```

约定：

- 每次生成的 sequence 从 0 开始且严格连续；
- 前端按 `generationId` 过滤；
- 乱序时前端请求取消并报 `MODEL_EVENT_SEQUENCE_INVALID`；
- delta 只包含候选输出，不包含 Prompt、API Key 或其他凭据；
- completed 没有有效正文时返回 `MODEL_OUTPUT_EMPTY`；
- 完成、失败、取消或超时后解除监听。

## 8. 项目密钥与恢复材料

前端：`apps/desktop/src/infrastructure/project-key-vault.ts`  
后端：`apps/desktop/src-tauri/src/project_keys.rs`

| Command                                       | 参数                                       | 返回                                        |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| `create_device_identity`                      | `{deviceId}`                               | `DeviceIdentitySummary`                     |
| `get_device_identity_status`                  | `{deviceId}`                               | `{configured,identity}`                     |
| `generate_project_data_key`                   | 无                                         | `{rawProjectDataKey,projectKeyFingerprint}` |
| `wrap_project_data_key_for_device`            | `{input:WrapProjectDataKeyInput}`          | `DeviceProjectKeyEnvelopeContract`          |
| `unwrap_project_data_key_for_device`          | `{envelope}`                               | `ProjectDataKeyMaterial`                    |
| `rewrap_project_data_key_for_team_recipients` | 团队、项目、版本、发送设备、源信封和收件人 | `TeamProjectKeyEnvelope[]`                  |
| `create_project_recovery_kit`                 | 恢复 ID、项目、版本和项目密钥              | `{recoveryCode,envelope}`                   |
| `verify_project_recovery_kit`                 | `{recoveryCode,envelope}`                  | `{valid:true,projectKeyFingerprint}`        |
| `recover_project_data_key`                    | `{recoveryCode,envelope}`                  | `ProjectDataKeyMaterial`                    |

关键契约：

- 设备算法：`DHKEM-P256-HKDF-SHA256`；
- 设备信封：`HPKE-AUTH-P256-HKDF-SHA256-AES128GCM`；
- 恢复信封：`ARGON2ID-AES256GCM`；
- 项目数据密钥为 32 字节；
- 恢复码前缀为 `INK1_`；
- 私钥只存在 OS 凭据库，前端只得到公钥摘要；
- ID、版本、指纹和收发设备必须完全匹配；
- 团队收件人上限为 10000。

主要错误：`DEVICE_ID_INVALID`、`DEVICE_IDENTITY_MISSING`、`PROJECT_DATA_KEY_INVALID`、
`PROJECT_KEY_ENVELOPE_INVALID`、`PROJECT_KEY_RECIPIENT_MISMATCH`、
`PROJECT_KEY_WRAP_FAILED`、`PROJECT_KEY_OPEN_FAILED`、`PROJECT_KEY_VAULT_UNAVAILABLE`、
`RECOVERY_CODE_INVALID`、`RECOVERY_ENVELOPE_INVALID`、`RECOVERY_CRYPTO_FAILED`、
`TEAM_PROJECT_KEY_ENVELOPE_SCOPE_MISMATCH`、`TEAM_PROJECT_KEY_RECEIPT_BINDING_MISMATCH`、
`TEAM_PROJECT_KEY_RECEIPT_ROLLBACK_BLOCKED`。

## 9. 云会话、原生中继与团队密钥

### 9.1 云会话

前端：`apps/desktop/src/infrastructure/cloud-session-vault.ts`  
后端：`apps/desktop/src-tauri/src/cloud_session.rs`

| Command                       | 参数                                | 返回                      |
| ----------------------------- | ----------------------------------- | ------------------------- |
| `login_cloud_identity`        | endpoint、email、password、device   | `CloudSessionVaultStatus` |
| `verify_cloud_identity_email` | endpoint、challengeId、code、device | `CloudSessionVaultStatus` |
| `refresh_cloud_session`       | `{expectedSessionId}`               | `CloudSessionVaultStatus` |
| `get_cloud_session_status`    | 无                                  | `CloudSessionVaultStatus` |
| `logout_cloud_session`        | `{expectedSessionId}`               | 空会话状态                |
| `clear_cloud_session`         | `{expectedSessionId:string          | null}`                    | 空会话状态 |

```ts
interface CloudSessionVaultStatus {
  configured: boolean;
  account: CloudAccountContract | null;
  device: CloudDeviceContract | null;
  session: CloudSessionContract | null;
  expiry: {
    accessExpiresAt: string;
    refreshExpiresAt: string;
  } | null;
}
```

访问 Token 和刷新 Token 不返回 WebView，完整会话保存在 OS 凭据库的
`cloud:active-session` 项。

### 9.2 通用 Cloud API 中继

前端：`apps/desktop/src/infrastructure/tauri-cloud-transport.ts`  
后端 command：`send_cloud_api_request`

```ts
send_cloud_api_request({
  input: {
    baseUrl: string;
    allowInsecureLoopback: boolean;
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    headers: Record<string, string>;
    body: unknown;
    authentication: "none" | "session";
  };
});
```

返回：

```ts
{
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
```

中继只接收 `X-Request-Id` 和必要时的 `Idempotency-Key`。WebView 不能传入
`Authorization`，body 也不能含 `authorization`、`accessToken`、`refreshToken`、`tokens`
或 `password` 字段。Bearer Token 由 Rust 从凭据库附加。

响应头只暴露 `content-type`、`retry-after` 和 `x-request-id`。最大响应 64 MB，连接超时
10 秒，请求超时 30 秒，不允许 HTTP 重定向。

### 9.3 密码删除专用中继

`send_cloud_deletion_credential_request` 只允许：

- `request_project`
- `request_account`
- `lookup_account`
- `cancel_account`

密码在 Rust 输入销毁时清零；普通 Cloud 中继不能携带密码。

### 9.4 团队项目密钥收据

| Command                                                      | 输入                                         | 返回                                    |
| ------------------------------------------------------------ | -------------------------------------------- | --------------------------------------- |
| `accept_current_device_team_project_key_envelope_from_cloud` | 团队、项目、预期会话、账户、设备、公钥和指纹 | `NativeTeamProjectKeyReceiptCommit`     |
| `inspect_stored_team_project_key_receipt`                    | `{expectedSessionId,receipt}`                | `{configured,nativeReceiptFingerprint}` |
| `open_stored_team_project_key_receipt`                       | 同上                                         | `ProjectDataKeyMaterial`                |
| `remove_stored_team_project_key_receipt`                     | 同上                                         | `{removed}`                             |

原生层会重新读取云端当前 key metadata 和设备信封，并核验会话、账户、设备、公钥、版本和
服务端 revision。

主要云错误：`CLOUD_ENDPOINT_INVALID`、`CLOUD_SESSION_NOT_CONFIGURED`、
`CLOUD_SESSION_ALREADY_CONFIGURED`、`CLOUD_SESSION_CHANGED`、
`CLOUD_SESSION_ENDPOINT_MISMATCH`、`CLOUD_SESSION_CREDENTIAL_CORRUPTED`、
`CLOUD_DEVICE_IDENTITY_MISMATCH`、`CLOUD_RELAY_REQUEST_INVALID`、
`CLOUD_RELAY_ROUTE_FORBIDDEN`、`CLOUD_AUTHORIZATION_INPUT_FORBIDDEN`、
`CLOUD_NETWORK_UNAVAILABLE`、`CLOUD_REQUEST_TIMEOUT`、`CLOUD_RESPONSE_TOO_LARGE`、
`CLOUD_PROTOCOL_INVALID_RESPONSE`、`CLOUD_HTTP_REDIRECT_FORBIDDEN`。

## 10. 安全更新

前端：`apps/desktop/src/infrastructure/secure-updater.ts`  
页面：`apps/desktop/src/pages/secure-update-card.tsx`  
后端：`apps/desktop/src-tauri/src/secure_updater.rs`

| Command                               | 参数       | 返回                                                                        |
| ------------------------------------- | ---------- | --------------------------------------------------------------------------- |
| `inspect_secure_update_configuration` | 无         | enabled、currentVersion、channel、disabledReason、`executesInstaller:false` |
| `check_for_signed_update`             | 无         | `SignedUpdateCheck`                                                         |
| `stage_signed_update`                 | `{planId}` | `StagedUpdateReceipt`                                                       |

`planId` 必须是 64 位小写 SHA-256 十六进制。当前流程只：

1. 下载并验证 Ed25519 签名 manifest；
2. 校验序列号、防回滚、安全基线和时间窗口；
3. 下载同源 artifact；
4. 校验大小和 SHA-256；
5. 保存为不可执行的 `.pending` 文件。

当前不会运行安装包，返回值固定说明：

```ts
{
  packageState: "digest_verified_inert_staging";
  authenticodeStatus: "not_verified";
  installationAllowed: false;
  nextRequiredAction: "VERIFY_AUTHENTICODE_PUBLISHER_IN_RELEASE_PIPELINE";
}
```

页面动作与此边界保持一致：可检查更新，并在 `update_available` 时“下载并校验更新包（不安装）”；
校验完成后只显示隔离暂存状态。清单提供通过校验的 HTTPS `releaseNotesUrl` 时，页面可打开
“查看官方发行说明”；没有可信链接时不会猜测下载地址。`manual_update_required` 和
`rollback_available` 也只给出人工处理说明，不宣称自动安装或自动回退。

主要错误族：`UPDATE_CONFIGURATION_*`、`UPDATE_MANIFEST_*`、`UPDATE_SIGNATURE_INVALID`、
`UPDATE_ARTIFACT_*`、`UPDATE_PLAN_*`、`UPDATE_STAGE_*`、`UPDATE_CHECKPOINT_*` 和
`UPDATE_OPERATION_BUSY`。

## 11. Cloud REST API 通用约定

权威来源：

- `packages/contracts/src/cloud-openapi.ts`
- `packages/contracts/src/openapi.ts`
- `packages/contracts/src/cloud-api-schemas.ts`
- `packages/contracts/src/team-api-schemas.ts`
- `packages/contracts/src/usage-api-schemas.ts`
- `packages/contracts/src/review-api-schemas.ts`
- `packages/contracts/src/team-template-api-schemas.ts`
- `packages/contracts/src/marketplace-api-schemas.ts`
- `packages/contracts/src/enterprise-api-schemas.ts`

标记说明：

- `A`：要求认证，Desktop 由 Rust 附加 Bearer；
- `I`：要求稳定的 `Idempotency-Key`；
- `N`：必须经过原生密码边界；
- `relay`：当前通用原生中继允许；
- `session`：通过云会话专用 command；
- `password`：通过密码删除专用 command；
- `key-native`：通过团队密钥专用 command；
- `blocked`：契约和 TypeScript 客户端存在，但当前 Desktop 原生中继未放行。

所有请求要求 `X-Request-Id: UUIDv7`。请求和响应经过严格 Zod 校验，响应中的 requestId
必须与请求一致。

## 12. Cloud REST operation 完整表

### 12.1 账户、身份、会话与设备

| Operation                       | 方法与路径                                        | 安全  | 请求 → 成功返回                                                      | Desktop 接入 |
| ------------------------------- | ------------------------------------------------- | ----- | -------------------------------------------------------------------- | ------------ |
| `accountDeletions.request`      | POST `/v1/account/deletion-requests`              | A I N | `AccountDeletionSubmissionRequest` → 202 `DeletionRequestResponse`   | password     |
| `accountDeletions.lookup`       | POST `/v1/account/deletion-request-lookups`       | N     | `AccountDeletionLookupRequest` → 200 `DeletionRequestResponse`       | password     |
| `accountDeletions.cancel`       | POST `/v1/account/deletion-cancellations`         | I N   | `AccountDeletionCancellationRequest` → 200 `DeletionRequestResponse` | password     |
| `identity.register`             | POST `/v1/identity/registrations`                 | I     | `IdentityRegistrationRequest` → 202 `IdentityChallengeResponse`      | relay        |
| `identity.verifyEmail`          | POST `/v1/identity/verifications`                 | I     | `IdentityVerificationRequest` → 200 `SessionGrantResponse`           | session      |
| `identity.requestPasswordReset` | POST `/v1/identity/password-resets`               | I     | `PasswordResetRequest` → 202 `IdentityChallengeResponse`             | relay        |
| `identity.confirmPasswordReset` | POST `/v1/identity/password-resets/confirmations` | I     | `PasswordResetConfirmationRequest` → 202 `MutationAcceptedResponse`  | relay        |
| `auth.login`                    | POST `/v1/auth/sessions`                          | I     | `AuthenticationRequest` → 200 `SessionGrantResponse`                 | session      |
| `auth.refresh`                  | POST `/v1/auth/session-rotations`                 | I     | `SessionRefreshRequest` → 200 `SessionGrantResponse`                 | session      |
| `auth.logout`                   | POST `/v1/auth/session-revocations`               | A I   | `SessionLogoutRequest` → 202 `MutationAcceptedResponse`              | session      |
| `auth.listSessions`             | GET `/v1/auth/sessions?cursor&limit`              | A     | 无 body → 200 `SessionListResponse`                                  | relay        |
| `auth.revokeSession`            | DELETE `/v1/auth/sessions/{sessionId}`            | A I   | 无 body → 202 `MutationAcceptedResponse`                             | relay        |
| `devices.list`                  | GET `/v1/devices?cursor&limit`                    | A     | 无 body → 200 `DeviceListResponse`                                   | relay        |
| `devices.register`              | POST `/v1/devices`                                | A I   | `DeviceRegistrationRequest` → 201 `DeviceResponse`                   | relay        |
| `devices.revoke`                | DELETE `/v1/devices/{deviceId}`                   | A I   | 无 body → 200 `DeviceResponse`                                       | relay        |

前端调用链主要位于 `cloud-session-vault.ts`、`cloud-identity-service.ts`、
`cloud-account-management-service.ts`、`cloud-deletion-lifecycle-service.ts`、
`cloud-login-page.tsx` 和 `sync-security-page.tsx`。

### 12.2 团队与项目 assignment

| Operation                 | 方法与路径                                                               | 安全 | 请求 → 成功返回                                                        | Desktop 接入 |
| ------------------------- | ------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------- | ------------ |
| `teams.create`            | POST `/v1/teams`                                                         | A I  | `TeamCreateRequest` → 201 `TeamResponse`                               | relay        |
| `teams.list`              | GET `/v1/teams?cursor&limit`                                             | A    | 无 body → 200 `TeamListResponse`                                       | relay        |
| `teamMembers.list`        | GET `/v1/teams/{teamId}/members?cursor&limit`                            | A    | 无 body → 200 `TeamMemberListResponse`                                 | relay        |
| `teamInvitations.create`  | POST `/v1/teams/{teamId}/invitations`                                    | A I  | `TeamInvitationCreateRequest` → 201 `TeamInvitationResponse`           | relay        |
| `teamInvitations.accept`  | POST `/v1/team-invitations/{invitationId}/acceptances`                   | A I  | `TeamInvitationAcceptRequest` → 200 `TeamInvitationAcceptanceResponse` | relay        |
| `teamMembers.changeRole`  | POST `/v1/teams/{teamId}/members/{membershipId}/role-changes`            | A I  | `TeamMemberRoleChangeRequest` → 200 `TeamMembershipResponse`           | relay        |
| `teamMembers.revoke`      | POST `/v1/teams/{teamId}/members/{membershipId}/revocations`             | A I  | `TeamMembershipRevokeRequest` → 200 `TeamMembershipResponse`           | relay        |
| `projectAssignments.list` | GET `/v1/teams/{teamId}/projects/{projectId}/assignments?cursor&limit`   | A    | 无 body → 200 `ProjectAssignmentListResponse`                          | relay        |
| `projectAssignments.set`  | PUT `/v1/teams/{teamId}/projects/{projectId}/assignments/{membershipId}` | A I  | `ProjectAssignmentSetRequest` → 200 `ProjectAssignmentResponse`        | relay        |

前端：`cloud-team-workspace-service.ts`、`studio-team-page.tsx`。  
后端：`team-service.ts`。

### 12.3 Enterprise

| Operation                     | 方法与路径                                              | 请求 → 成功返回                                                                | Desktop 接入 |
| ----------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------ |
| `enterprisePolicies.get`      | GET `/v1/teams/{teamId}/enterprise/policy`              | 200 `EnterprisePolicyResponse`                                                 | blocked      |
| `enterprisePolicies.update`   | PUT 同路径                                              | `EnterprisePolicyUpdateRequest` → 200 `EnterprisePolicyResponse`               | blocked      |
| `enterprisePolicies.evaluate` | POST `/v1/teams/{teamId}/enterprise/policy-evaluations` | `EnterprisePolicyEvaluationRequest` → 200 `EnterprisePolicyEvaluationResponse` | blocked      |
| `enterpriseSso.getStatus`     | GET `/v1/teams/{teamId}/enterprise/sso`                 | 200 `EnterpriseSsoStatusResponse`                                              | blocked      |
| `enterpriseSso.authorize`     | POST `/v1/enterprise/sso/authorizations`                | `EnterpriseSsoAuthorizationRequest` → 201 `EnterpriseSsoAuthorizationResponse` | blocked      |
| `enterpriseSso.complete`      | POST `/v1/enterprise/sso/callbacks`                     | `EnterpriseSsoCallbackRequest` → 200 `EnterpriseSsoSessionResponse`            | blocked      |

这些 operation 各自仍按契约要求认证和幂等；当前 Desktop 没有允许其路径的原生中继。

### 12.4 AI 预算与用量

| Operation                 | 方法与路径                                                           | 请求 → 成功返回                                                 | Desktop 接入 |
| ------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- | ------------ |
| `aiBudgets.updateTeam`    | PUT `/v1/teams/{teamId}/ai-budget`                                   | `AiTeamBudgetUpdateRequest` → 200 `AiTeamBudgetResponse`        | blocked      |
| `aiBudgets.updateProject` | PUT `/v1/teams/{teamId}/projects/{projectId}/ai-budget`              | `AiProjectBudgetUpdateRequest` → 200 `AiProjectBudgetResponse`  | blocked      |
| `aiUsage.getSummary`      | GET `/v1/teams/{teamId}/ai-usage?projectId`                          | 200 `AiUsageSummaryResponse`                                    | blocked      |
| `aiUsage.listEvents`      | GET `/v1/teams/{teamId}/ai-usage/events?cursor&limit&projectId`      | 200 `AiUsageEventListResponse`                                  | blocked      |
| `aiUsage.reserve`         | POST `/v1/teams/{teamId}/projects/{projectId}/ai-usage/reservations` | `AiUsageReservationRequest` → 201 `AiUsageReservationResponse`  | blocked      |
| `aiUsage.settle`          | POST `.../{reservationId}/settlements`                               | `AiUsageSettlementRequest` → 200 `AiUsageReservationResponse`   | blocked      |
| `aiUsage.cancel`          | POST `.../{reservationId}/cancellations`                             | `AiUsageCancellationRequest` → 200 `AiUsageReservationResponse` | blocked      |

前端：`cloud-ai-usage-service.ts`、`studio-usage-page.tsx`。  
后端：`usage-service.ts`。

### 12.5 团队项目密钥

| Operation                                  | 方法与路径                                                                 | 请求 → 成功返回                                                               | Desktop 接入 |
| ------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------ |
| `teamProjectKeys.getCurrent`               | GET `/v1/teams/{teamId}/projects/{projectId}/keys/current`                 | 200 `TeamProjectCurrentKeyResponse`                                           | relay        |
| `teamProjectKeyRecipients.list`            | GET `/v1/teams/{teamId}/projects/{projectId}/keys/{keyVersion}/recipients` | 200 `TeamProjectKeyEligibleRecipientListResponse`                             | relay        |
| `teamProjectKeyEnvelopes.publish`          | POST `.../{keyVersion}/envelopes`                                          | `TeamProjectKeyEnvelopePublishRequest` → 201 `TeamProjectKeyEnvelopeResponse` | relay        |
| `teamProjectKeyEnvelopes.getCurrentDevice` | GET `.../{keyVersion}/envelopes/current-device`                            | 200 `TeamProjectKeyEnvelopeResponse`                                          | key-native   |

### 12.6 云端审阅

所有写操作要求认证和幂等键。

| Operation                          | 方法与路径                                                   | 请求 → 成功返回                                                            | Desktop 接入 |
| ---------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------ |
| `reviews.submit`                   | POST `/v1/teams/{teamId}/projects/{projectId}/reviews`       | `ReviewSubmissionRequest` → 201 `ReviewResponse`                           | blocked      |
| `reviews.list`                     | GET 同路径 `?cursor&limit`                                   | 200 `ReviewListResponse`                                                   | blocked      |
| `reviews.get`                      | GET `.../reviews/{reviewId}`                                 | 200 `ReviewResponse`                                                       | blocked      |
| `reviewDecisions.create`           | POST `.../{reviewId}/decisions`                              | `ReviewDecisionRequest` → 200 `ReviewResponse`                             | blocked      |
| `reviewThreadItems.append`         | POST `.../{reviewId}/thread-items`                           | `ReviewThreadItemAppendRequest` → 201 `ReviewThreadItemResponse`           | blocked      |
| `reviewThreads.list`               | GET `.../{reviewId}/threads?cursor&limit`                    | 200 `ReviewThreadListResponse`                                             | blocked      |
| `reviewThreadItems.list`           | GET `.../threads/{threadId}/items?cursor&limit`              | 200 `ReviewThreadItemListResponse`                                         | blocked      |
| `reviewThreads.resolve`            | POST `.../threads/{threadId}/resolutions`                    | `ReviewThreadResolutionRequest` → 200 `ReviewThreadResponse`               | blocked      |
| `reviewSuggestionDecisions.create` | POST `.../threads/{threadId}/suggestions/{itemId}/decisions` | `ReviewSuggestionDecisionRequest` → 200 `ReviewSuggestionDecisionResponse` | blocked      |

前端：`studio-review-runtime.ts`、`studio-review-service.ts`、`studio-review-page.tsx`。  
后端：`review-service.ts`。

### 12.7 团队模板

| Operation                         | 方法与路径                                               | 请求 → 成功返回                                                         | Desktop 接入 |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- | ------------ |
| `teamTemplates.create`            | POST `/v1/teams/{teamId}/projects/{projectId}/templates` | `TeamTemplateCreateRequest` → 201 `TeamTemplateMutationResponse`        | blocked      |
| `teamTemplates.list`              | GET 同路径 `?cursor&limit`                               | 200 `TeamTemplateListResponse`                                          | blocked      |
| `teamTemplates.get`               | GET `.../templates/{templateId}`                         | 200 `TeamTemplateResponse`                                              | blocked      |
| `teamTemplateVersions.create`     | POST `.../{templateId}/versions`                         | `TeamTemplateVersionCreateRequest` → 201 `TeamTemplateMutationResponse` | blocked      |
| `teamTemplateVersions.list`       | GET 同路径 `?cursor&limit`                               | 200 `TeamTemplateVersionListResponse`                                   | blocked      |
| `teamTemplateVersions.get`        | GET `.../versions/{versionId}`                           | 200 `TeamTemplateVersionResponse`                                       | blocked      |
| `teamTemplates.clone`             | POST `.../{templateId}/clones`                           | `TeamTemplateCloneRequest` → 201 `TeamTemplateMutationResponse`         | blocked      |
| `teamTemplates.publish`           | POST `.../{templateId}/publications`                     | `TeamTemplatePublishRequest` → 200 `TeamTemplateResponse`               | blocked      |
| `teamTemplates.archive`           | POST `.../{templateId}/archives`                         | `TeamTemplateArchiveRequest` → 200 `TeamTemplateResponse`               | blocked      |
| `teamTemplateApplications.record` | POST `.../{templateId}/applications`                     | `TeamTemplateApplyRequest` → 201 `TeamTemplateApplicationResponse`      | blocked      |

### 12.8 Marketplace

| Operation                         | 方法与路径                                              | 请求 → 成功返回                                                         | Desktop 接入 |
| --------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- | ------------ |
| `marketplace.listCatalog`         | GET `/v1/marketplace/artifacts?cursor&limit&kind`       | 200 `MarketplaceCatalogResponse`                                        | relay        |
| `marketplace.submitVersion`       | POST `/v1/marketplace/artifacts/submissions`            | `MarketplaceSubmissionRequest` → 201 `MarketplaceSubmissionResponse`    | relay        |
| `marketplace.moderateVersion`     | POST `.../{artifactId}/versions/{versionId}/moderation` | `MarketplaceModerationRequest` → 200 `MarketplaceSubmissionResponse`    | blocked      |
| `marketplace.reportVersion`       | POST `.../{versionId}/reports`                          | `MarketplaceReportRequest` → 201 `MarketplaceReportResponse`            | relay        |
| `marketplace.withdrawVersion`     | POST `.../{versionId}/withdrawals`                      | `MarketplaceWithdrawalRequest` → 200 `MarketplaceSubmissionResponse`    | relay        |
| `marketplace.appealVersion`       | POST `.../{versionId}/appeals`                          | `MarketplaceAppealRequest` → 201 `MarketplaceAppealResponse`            | relay        |
| `marketplace.disposeReport`       | POST `/v1/marketplace/reports/{reportId}/dispositions`  | `MarketplaceReportDispositionRequest` → 200 `MarketplaceReportResponse` | blocked      |
| `marketplace.disposeAppeal`       | POST `/v1/marketplace/appeals/{appealId}/dispositions`  | `MarketplaceAppealDispositionRequest` → 200 `MarketplaceAppealResponse` | blocked      |
| `marketplace.download`            | POST `/v1/marketplace/artifacts/{artifactId}/downloads` | `MarketplaceDownloadRequest` → 200 `MarketplaceDownloadResponse`        | relay        |
| `marketplace.listModerationQueue` | GET `/v1/marketplace/moderation/queue?cursor&limit`     | 200 `MarketplaceModerationQueueResponse`                                | blocked      |

### 12.9 项目删除、项目密钥与同步

| Operation                    | 方法与路径                                                      | 请求 → 成功返回                                                    | Desktop 接入 |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ | ------------ |
| `projectDeletions.request`   | POST `/v1/projects/{projectId}/deletion-requests`               | `DeletionSubmissionRequest` → 202 `DeletionRequestResponse`        | password     |
| `projectDeletions.get`       | GET `/v1/projects/{projectId}/deletion-request`                 | 200 `DeletionRequestResponse`                                      | relay        |
| `projectDeletions.cancel`    | POST `/v1/projects/{projectId}/deletion-cancellations`          | `DeletionCancellationRequest` → 200 `DeletionRequestResponse`      | relay        |
| `projectKeys.publish`        | PUT `/v1/projects/{projectId}/keys/{keyVersion}`                | `ProjectKeyPublishRequest` → 200 `ProjectKeyResponse`              | relay        |
| `projectKeys.get`            | GET 同路径                                                      | 200 `ProjectKeyResponse`                                           | relay        |
| `projectKeys.getCurrent`     | GET `/v1/projects/{projectId}/keys/current`                     | 200 `ProjectKeyResponse`                                           | relay        |
| `projects.getState`          | GET `/v1/projects/{projectId}?cursor`                           | 200 `ProjectStateResponse`                                         | relay        |
| `sync.push`                  | POST `/v1/projects/{projectId}/sync/push`                       | `SyncPushRequest` → 200 `SyncPushResponse`                         | relay        |
| `sync.pull`                  | GET `/v1/projects/{projectId}/sync/pull?cursor&limit`           | 200 `SyncPullResponse`                                             | relay        |
| `sync.snapshot`              | GET `/v1/projects/{projectId}/sync/snapshot?cursor&limit`       | 200 `SyncSnapshotResponse`                                         | relay        |
| `sync.acknowledgeTombstones` | POST `/v1/projects/{projectId}/sync/tombstone-acknowledgements` | `TombstoneAcknowledgementRequest` → 202 `MutationAcceptedResponse` | relay        |

## 13. 当前 Cloud 接入限制

81 个 operation 是公共契约目录，不是当前 Desktop 可达目录。

`apps/desktop/src-tauri/src/cloud_session.rs` 中的 `validate_relay_route` 只开放经过审核的子集。
当前这些前端运行时虽然已有 TypeScript 客户端或页面代码，但会被 Rust 以
`CLOUD_RELAY_ROUTE_FORBIDDEN` 拒绝：

- Enterprise policy 与 SSO；
- 团队 AI budget 与 usage；
- Studio 云端 review；
- Team templates；
- Marketplace 审核队列、审核和管理端处置。

因此判断功能是否可用时必须同时检查：

1. Cloud 契约是否定义；
2. Desktop 原生中继是否允许；
3. 运行时是否接线；
4. Feature Flag 是否开启；
5. 真实 Cloud 服务和权限是否可用。

## 14. 浏览器开发模式 localStorage

下表键用于 `createDevelopmentRuntime(window.localStorage)`；正式 Tauri 业务数据使用 SQLite。

| 键                                                         | Schema | 内容                                                                         | 实现                                   |
| ---------------------------------------------------------- | -----: | ---------------------------------------------------------------------------- | -------------------------------------- |
| `inkshadow.development.database.v1`                        |      2 | 项目、章节、版本、恢复草稿、候选、审计                                       | `development-storage.ts`               |
| `inkshadow.development.story.v1`                           |      6 | 大纲、正式设定、时间线、记忆、What-if、审阅、构思                            | `story-storage.ts`                     |
| `inkshadow.development.ideation-project-commit.journal.v1` |      1 | 跨存储键预提交日志                                                           | `development-atomic-journal.ts`        |
| `inkshadow.development.materials.v1`                       |      1 | 素材与引用                                                                   | `material-storage.ts`                  |
| `inkshadow.development.model-center.v1`                    |      2 | 模型配置和定价，不含 API Key                                                 | `model-center-store.ts`                |
| `inkshadow.development.model-routing.v1`                   |      1 | 角色到模型路由                                                               | `model-routing-store.ts`               |
| `inkshadow.development.generation-governance.v1`           |      2 | 预算、运行、用量和延期请求                                                   | `generation-governance-store.ts`       |
| `inkshadow.development.project-search.v1`                  |      1 | 项目搜索快照                                                                 | `project-search-store.ts`              |
| `inkshadow.development.task-center.v1`                     |      1 | 任务与通知                                                                   | `task-center-store.ts`                 |
| `inkshadow.marketplace.installs.v1`                        |      1 | 浏览器模式已安装市场资产                                                     | `marketplace-runtime.ts`               |
| `inkshadow.development.creative-journeys.v1`               |      1 | 一句话开书三槽请求、一次性 0–3 问确定性计划、回答/跳过和逐轮恢复             | `creative-journey-store.ts`            |
| `inkshadow.development.project-seeds.v1`                   |      1 | 项目创建后的 `ProjectSeed` 副本                                              | `project-seed-local-store.ts`          |
| `inkshadow.development.model-hub.v1`                       |      6 | Model Hub 连接、目录、能力、路由、策略、调用及脱敏失败元数据；原位升级 v1–v5 | `model-hub-store.ts`                   |
| `inkshadow.development.story-facts.v1`                     |      2 | 浏览器调试模式统一 StoryFact、修订与连续提取回执                             | `story-fact-store.ts`                  |
| `inkshadow.development.causal-event-graphs.v1`             |      1 | 浏览器调试模式可重建因果图                                                   | `causal-event-graph-store.ts`          |
| `inkshadow.development.context-compilation-traces.v1`      |      2 | 内容最小化上下文历史及精确生成/调用/输出关联；原位读取 v1                    | `context-compilation-trace-store.ts`   |
| `inkshadow.development.writing-feedback.v1`                |      3 | 可见、可编辑且幂等的写作反馈学习                                             | `writing-feedback-store.ts`            |
| `inkshadow.development.story-planning-candidates.v1`       |      1 | 可审阅 AI 剧情规划候选                                                       | `story-planning-candidate-store.ts`    |
| `inkshadow.development.chapter-validation-snapshots.v1`    |      1 | 绑定当前不可变章节版本的确定性检查快照                                       | `chapter-validation-snapshot-store.ts` |
| `inkshadow.development.writing-experience.v1`              |      1 | 浏览器调试模式写作方式、本地整理授权与内容无关 Provider 披露 grant           | `writing-experience-store.ts`          |

正式 Tauri Marketplace 安装记录使用 SQLite 表 `community_marketplace_installs`。

以下页面恢复与偏好键也会在正式 Desktop WebView 使用。它们不保存稳定正文、模型密钥或正式
StoryFact，但创建/改写表单本身可能包含用户输入，因此仍属于本机恢复数据：

| 键                                                                    | 内容                                                                                                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inkshadow.appearance.preference.v1`                                  | `system`、`light` 或 `dark` 外观选择                                                                                                                              |
| `inkshadow.editor.preferences.v1`                                     | 自动保存开关和延迟；损坏或越界值回退到安全默认值                                                                                                                  |
| `inkshadow.editor.view-state.v1`                                      | 排版、光标和滚动位置                                                                                                                                              |
| `inkshadow.export.last-receipt.v1`                                    | 最近一次导出回执及项目 ID；原生绝对路径只来自已验证回执，浏览器状态固定为 `path_not_available`                                                                    |
| `inkshadow.example-project.v1`                                        | 示例项目和章节的本地快捷指针；不复制正文                                                                                                                          |
| `inkshadow.import-rewrite-journey.v2`                                 | 导入项目指针、历史分析检查点、改写目标、试改候选指针、反馈、规则和逐章 Candidate 精确修订号；不复制已导入稳定正文。当前只恢复查看与显式决定，不恢复 Provider 派发 |
| `inkshadow.import-rewrite-pending.v1`                                 | 旧的未收尾导入分析/改写请求 ID、供应商、模型、章节与任务类型；不保存请求正文，也不会在当前入口自动恢复或重发                                                      |
| `inkshadow.professional-create-recovery.v1`                           | 专业创建表单、项目恢复指针和 `ProjectSeed`；不保存章节正文                                                                                                        |
| `inkshadow.chapter-summary.auto-on-manual-save.v1:<projectId>`        | 旧偏好兼容键；当前页面读到后立即归一为关闭，不能授权手动保存发送正文                                                                                              |
| `inkshadow.continuous-story-state.auto-on-manual-save.v1:<projectId>` | 旧偏好兼容键；当前页面读到后立即归一为关闭，不能授权手动保存发送正文                                                                                              |

编辑器另用 `inkshadow.editor.view-state.v1` 保存：

```ts
{
  schemaVersion: 1;
  typography: {
    fontFamily: "serif" | "sans" | "mono";
    fontSize: number;
    lineHeight: number;
    measure: "narrow" | "comfortable" | "wide";
  }
  entries: Array<{
    projectId: string;
    chapterId: string;
    selection: EditorSelection;
    scrollTop: number;
    updatedAt: number;
  }>;
}
```

该键只保存 UUID、光标、滚动和排版，不保存正文；最多 100 条，序列化上限 262144 字节，
损坏时清除。

## 15. Web Guest 应用服务与 IndexedDB

Web Guest 不使用 Tauri IPC，也不调用 Cloud HTTP。

主要服务：

```ts
class GuestWorkspaceService {
  listEncryptedProjects(): Promise<readonly GuestEncryptedProjectDescriptor[]>;
  createEncryptedProject(
    input: CreateEncryptedGuestProjectInput,
  ): Promise<CreateEncryptedGuestProjectOutcome>;
  prepareEncryptedProject(
    input: CreateEncryptedGuestProjectInput,
  ): Promise<CreateEncryptedGuestProjectOutcome>;
  commitPreparedProject(projectId: UuidV7): Promise<GuestProjectSession>;
  discardPreparedProject(projectId: UuidV7): void;
  unlockProject(projectId: UuidV7, recoveryMaterial: string): Promise<GuestProjectSession>;
  saveChapter(input: SaveEncryptedGuestChapterInput): Promise<GuestProjectSession>;
  preserveTemporaryDraft(input: SaveEncryptedGuestChapterInput): Promise<void>;
  exportEncryptedProject(projectId: UuidV7): Promise<string>;
  importEncryptedProject(payload: string, recoveryMaterial: string): Promise<GuestProjectSession>;
  lock(projectId: UuidV7): void;
  lockAll(): void;
  isUnlocked(projectId: UuidV7): boolean;
}
```

`GuestProjectSession` 在发现可恢复临时密文时会附带：

```ts
interface RecoveredGuestDraft {
  baseRevision: number;
  content: string;
}
```

加密副本导入的固定上限是 `32 * 1024 * 1024` 字节（32 MiB）。服务会先完成 JSON 解析、严格
记录 schema 与信封绑定检查，再用恢复材料解包项目密钥并解密、重建领域对象；只有全部成功后
才调用 `store.create(record)`。重复项目使用 IndexedDB `add()` 失败关闭，错误恢复材料、损坏
密文和无效领域数据同样不会留下部分记录。

IndexedDB：

- 数据库：`inkshadow-web-guest-v1`
- 版本：2
- Object Store：`encrypted-projects`（正式项目密文）、`encrypted-temporary-drafts`（自动锁定
  恢复密文）
- 两个 Store 的 Key Path 均为 `projectId`

```ts
interface EncryptedProjectStore {
  list(): Promise<readonly EncryptedGuestProjectRecordV1[]>;
  get(projectId: string): Promise<EncryptedGuestProjectRecordV1 | null>;
  create(record: EncryptedGuestProjectRecordV1): Promise<void>;
  appendChapter(
    projectId: string,
    expectedContentVersion: number,
    envelope: CipherEnvelopeV1,
  ): Promise<void>;
  getTemporaryDraft(projectId: string): Promise<EncryptedGuestDraftRecordV1 | null>;
  putTemporaryDraft(record: EncryptedGuestDraftRecordV1): Promise<void>;
  deleteTemporaryDraft(projectId: string): Promise<void>;
}
```

记录：

```ts
interface EncryptedGuestProjectRecordV1 {
  format: "inkshadow.web.guest-project";
  schemaVersion: 1;
  projectId: UuidV7;
  keyVersion: number;
  recovery: RecoveryEnvelopeV1;
  projectEnvelope: CipherEnvelopeV1;
  chapterEnvelopes: readonly CipherEnvelopeV1[];
}
```

信封：

```ts
interface CipherEnvelopeV1 {
  schemaVersion: 1;
  algorithm: "AES-256-GCM";
  projectId: UuidV7;
  objectType: "project-key" | "project" | "chapter";
  objectId: UuidV7;
  keyVersion: number;
  contentVersion: number;
  nonce: string;
  ciphertext: string;
}
```

自动锁定恢复记录：

```ts
interface EncryptedGuestDraftRecordV1 {
  format: "inkshadow.web.guest-draft";
  schemaVersion: 1;
  projectId: UuidV7;
  keyVersion: number;
  baseContentVersion: number;
  chapterEnvelope: CipherEnvelopeV1;
}
```

临时记录的章节信封必须绑定同一项目、密钥版本和章节，并使用
`baseContentVersion + 1`。它不能覆盖更新的正式版本；绑定不匹配、nonce 与正式记录重复、
解密失败或正式版本已经前进时会被忽略并尽力清理。

Web 恢复约定：

- KDF 为 `PBKDF2-SHA-256`，310000 次；
- 项目密钥是不可导出的 AES-GCM 256 `CryptoKey`；
- 明文项目密钥只存在 `SessionProjectKeyring` 内存 Map；
- 不写入 `localStorage` 或 `sessionStorage`；
- 页面刷新后必须用恢复材料重新解锁；
- 创建时先显示恢复材料，用户确认另存后才提交 IndexedDB；
- 恢复材料对话框同时显示项目名称、完整项目标识和创建时间，并可下载带标识的恢复文件；
- 手动锁定遇到未保存修改时，必须选择保存后锁定或明确放弃，保存失败时保持编辑会话和失败
  状态；
- 页面隐藏或 `pagehide` 触发自动锁定时，先尝试写入临时恢复密文和正式密文，再清除可见正文
  与会话密钥。正式保存失败但临时密文成功时，下次解锁返回 `recoveredDraft`；两种写入都失败
  时页面明确提示最近修改可能无法恢复；
- 正式保存成功后尽力删除临时恢复密文；临时密文只保存加密章节 envelope，不保存恢复材料、
  项目密钥或明文。

主要错误：`WEB_STORAGE_UNAVAILABLE`、`WEB_STORAGE_FAILED`、
`WEB_STORAGE_QUOTA_EXCEEDED`、`WEB_PROJECT_ALREADY_EXISTS`、`WEB_PROJECT_NOT_FOUND`、
`WEB_PROJECT_LOCKED`、`WEB_REVISION_CONFLICT`、`WEB_ENVELOPE_INVALID`、
`WEB_ENVELOPE_BINDING_MISMATCH`、`WEB_ENVELOPE_AUTHENTICATION_FAILED`、
`WEB_RECOVERY_MATERIAL_INVALID`、`WEB_UNLOCK_FAILED`、`WEB_VALIDATION_FAILED` 和
`WEB_CRYPTO_UNAVAILABLE`。

## 16. 窗口与生命周期

`apps/desktop/src/components/desktop-persistence-boundary.tsx` 使用：

- `getCurrentWindow()`
- `onCloseRequested(handler)`
- `event.preventDefault()`
- `appWindow.destroy()`

关闭顺序：

1. 同步阻止默认关闭；
2. 刷新所有挂起持久化；
3. 关闭运行时和 SQLite；
4. 最后销毁窗口。

路由切换通过 `PersistenceRouteBoundary` 执行最长 8 秒的刷新；失败时取消跳转。

Tauri capability 位于 `apps/desktop/src-tauri/capabilities/default.json`：

```json
{
  "windows": ["main"],
  "permissions": ["core:default", "core:window:allow-destroy", "log:default"]
}
```

开发专用 `webview-stress-controller.tsx` 还会使用原生日志和窗口关闭接口，但只在开发模式且
显式设置 `VITE_INKSHADOW_QA_WEBVIEW_STRESS=1` 时动态加载。

## 17. 自动备份运行时

`DesktopRuntime.automaticBackup` 是能力边界，而不是浏览器占位实现：

- Tauri 桌面运行时为 `AutomaticBackupRuntime`；
- 浏览器开发运行时固定为 `null`，不得显示“已自动备份”；
- 桌面启动完成后异步执行一次到期检查，失败只记录稳定错误码，不阻断本地工作区；
- 后续使用单实例、不重叠的安全定时器每小时重检；
- 运行时关闭时先停止定时器并等待正在执行的检查，再关闭 SQLite。

文件操作全部位于原生受限端口。前端只能持有根目录检查回执、租约 token、受验证清单和一次性
备份目的地 ticket；它不能选择自动备份目录、传入任意删除路径或枚举目录。真实备份仍调用既有
SQLite 一致性备份服务，浏览器不能用下载文件或内存对象冒充该能力。

接口总数中的 9 个自动备份 command 为：`native_automatic_backup_inspect_root`、
`native_automatic_backup_acquire_lease`、`native_automatic_backup_release_lease`、
`native_automatic_backup_read_manifest`、`native_automatic_backup_write_manifest`、
`native_automatic_backup_prepare_destination`、`native_automatic_backup_inspect_file`、
`native_automatic_backup_delete_file` 和 `native_automatic_backup_cleanup_failed_creation`。
它们只接受自动备份运行时签发和校验的受限标识，不构成通用文件系统 API。
