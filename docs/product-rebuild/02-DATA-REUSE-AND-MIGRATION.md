# 数据复用与迁移方案

> 文档状态：`AUTHORITATIVE_CURRENT`  
> 当前迁移上限：Data `0065` / Tauri `68`  
> 规则：只向前追加；当前源码目标版本为 `0.2.3`。

## 1. 迁移原则

1. 只追加新迁移，不修改当前已登记的 Data `0001`–`0064` 和 story-core `0001`–`0003`。
2. 现有项目、章节、版本、恢复草稿和 AI 候选 ID 全部保持不变。
3. 新投影必须可重建；正式事实和用户确认记录必须不可被重建任务覆盖。
4. 重大事实更新必须带用户决定；弱事实允许自动更新但可撤销。
5. 数据库不保存 API Key、完整凭据、密码、恢复码或云 Token。
6. 每项迁移必须在事务中完成，并通过旧库升级与失败回滚测试。

## 2. 直接复用

| 现有结构                       | 复用方式                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`                     | 作品容器；不新增平行“小说项目”表                                                                                                                                      |
| `chapters`、`chapter_versions` | 正文与稳定版本权威源                                                                                                                                                  |
| `recovery_drafts`              | 编辑器崩溃恢复和未保存恢复                                                                                                                                            |
| `ai_candidates`                | 所有正文生成、改写、续写和局部修改的 AI 建议版本                                                                                                                      |
| `story_ideation_drafts`        | 兼容旧快速/九步流程；新自适应会话独立追加结构并可映射                                                                                                                 |
| `story_outlines`               | 初步大纲和规划视图基础                                                                                                                                                |
| `story_formal_records`         | 兼容既有正式设定；迁移到统一事实视图时保留来源                                                                                                                        |
| `story_review_items`           | 兼容既有抽取/一致性决定；新验证问题增加专用证据结构                                                                                                                   |
| `story_memory_*`               | 作为旧分层记忆来源，不直接等同统一故事状态                                                                                                                            |
| `model_profiles`               | 迁移为“供应商连接”的兼容投影；旧 `keyring:legacy-model-profile:<providerId>` 仅作兼容读取，新写入使用与连接 ID 解耦的 `keyring:model-hub:<versioned-slot>` owned 引用 |
| `model_role_routes`            | 读取为旧路由，转换到新的小说任务路由；保留回退读取                                                                                                                    |
| 搜索与 GraphRAG 表             | 作为可重建派生索引，不作为正式事实权威源                                                                                                                              |
| 任务、通知、生成运行和用量     | 复用任务恢复、幂等、取消、费用和调用审计                                                                                                                              |

## 3. 追加数据模型

### 3.1 Phase 1：创作旅程与导入改写

实际迁移：`packages/data/migrations/0030_creative_journeys.sql`，Tauri/SQLx 版本 `33`。

已落地表：

`creative_journeys`

- `id`、`kind`（idea/import/professional）、`status`；
- `project_id`、`chapter_id` 可空；
- `current_state`、`revision`、`created_at`、`updated_at`；
- `snapshot_json`，只保存结构化回答、选项、进度和非秘密错误摘要。

`creative_journey_turns`

- 问题、用户选择/自定义回答、跳过/返回/重新生成动作；
- 生成来源、供应商、模型、任务类型和时间；
- 不把 API Key 写入记录。

以下仍是后续按真实闭环需要再决定是否拆分的候选表；当前导入旅程先把可恢复状态保存在旅程快照中：

`import_source_snapshots`

- 项目、来源文件名、格式、SHA-256、章节边界置信度、导入时间；
- 原文通过现有章节版本保存；来源记录只保存可追溯元数据。

`rewrite_rule_sets`

- 项目、规则 JSON、用户确认状态、修订号和来源试改。

`rewrite_trials`

- 原章节/版本/选区、对应候选 ID、反馈和状态；
- 批量任务只能引用已确认规则版本。

### 3.2 Phase 2：Model Hub

实际迁移：`packages/data/migrations/0031_model_hub.sql`，Tauri/SQLx 版本 `34`。

`model_provider_connections`

- 供应商预设 ID、协议、非秘密连接选项、地区/Workspace/Endpoint ID；
- 凭据引用键、连接状态、修订号；不保存密钥。

`model_catalog_entries`

- 连接 ID、模型 ID、显示名、发现时间、目录来源、可用状态；
- 目录可重新同步，不把模型名当能力真相。

`model_capability_evidence`

- 能力、结论（supported/unsupported/unknown）、来源（provider/preset/probe/user）、
  证据版本、探测时间和失败摘要。

`novel_task_routes`

- 小说任务、主连接/模型、备用连接/模型、参数预设、费用/隐私限制、修订号。

`model_hub_presets`

- 用户方案（smart/quality/economy/local_privacy/custom）和已生成路由版本。

`model_invocation_facts`

- 请求 ID、任务、供应商、模型、状态、Token/费用事实和错误码；
- 禁止保存正文、Prompt、密钥和完整模型响应。

### 3.3 Phase 3：统一故事状态、因果投影与上下文审计

第一层已实现：`packages/data/migrations/0032_unified_story_facts.sql`，Tauri/SQLx 版本 `35`。

- `story_facts`：类型、内容/结构化值、来源章节/文本证据或证据引用、生效/失效时间、分支、
  置信度、`formal/temporary/unconfirmed/deprecated/branch` 状态、用户确认、锁定、废弃和复核；
- `story_fact_revisions`：创建、旧数据回填、确认、治理更新和废弃的不可变快照；
- `story_fact_legacy_links`：新事实到旧正式记录/记忆记录的稳定链接与回填修订。

因果图迁移已实现：`packages/data/migrations/0033_causal_event_graph.sql`，Tauri/SQLx 版本 `36`。

- `causal_evidence_sources`：项目、章节、不可变版本、内容哈希、UTF-16 范围和精确摘录；
- `causal_events`：只保存确认投影中的事件、叙事时间、地点、事件与结果；
- 参与人物、前置条件、人物状态变化、关系变化、物品变化、知情人物和伏笔进度分别保存在受外键约束的子表；
- `causal_event_relations`：`causes/depends_on/prevents/reveals/misleads/before/changes_state/gains_information/loses_item`；
- 整套图是从用户确认且证据通过的 StoryFact 重建的投影，不是第二个正式事实权威源。

上下文审计迁移已实现：`packages/data/migrations/0034_context_compilation_trace.sql`，Tauri/SQLx 版本 `37`。

- `context_compilation_runs`：任务、项目/章节、预算、必选/采用/剩余/舍弃用量与估算器；
- `context_compilation_entries`：层级、选择原因、是否采用、舍弃原因、估算用量和预算变化；
- `context_compilation_entry_sources`：只保存来源类型、ID、版本、定位和内容哈希；
- 明确不保存正文、Prompt、候选内容、证据摘录、Embedding 或向量。

### 3.4 Phase 4：验证输入复用 StoryFact，检查快照不成为平行真相

当前确定性矛盾、声纹/POV 和叙事分析均把用户确认、带精确章节证据的 `story_facts.value_json`
适配为只读领域输入。采用版本化 schema 标识（例如 `inkshadow.character-voice-evidence.v1`、
`inkshadow.narrative-analysis-fact.v1`），证据不足则跳过。

迁移 `0040_chapter_validation_snapshots.sql`（Tauri/SQLx 版本 `43`）新增
`chapter_validation_snapshots`，只保存绑定不可变章节版本、规则版本和证据摘要的确定性检查
快照。快照用于历史追溯和恢复页面状态，不是正式故事事实；章节版本或规则变化后必须重新运行，
旧快照不得冒充当前检查结果。当前仍没有新增平行的 `validation_findings` 真相表或
`character_voice_profiles` 模型猜测表：

- 当前结论仍由当前章节版本和当前 StoryFact 重新计算；快照只证明某个固定版本曾运行哪些规则；
- 确定性问题的忽略、允许和更新设定决定仍写为带修订的 StoryFact；
- 声纹统计是从确认历史台词构建的运行时档案，不把模型猜测持久化；
- 多线、伏笔和节奏依赖显式 coverage，缺少数据时保留 `skipped`，不落一个虚假的“通过”状态。

迁移 `0042_chapter_validation_snapshot_delete_cascade.sql`（Tauri/SQLx 版本 `45`）不改写
已发布的 `0040`，而是用事务内表重建把快照自引用修正为安全级联：删除被替代快照、章节或
项目时不会再被旧自外键与不可变触发器互相阻塞，普通更新仍然被禁止。旧库升级、首条/全部
快照删除、章节/项目删除和备份恢复均有真实 SQLite 回归。

迁移 `0043_story_fact_entity_alias_resolution.sql`（Tauri/SQLx 版本 `46`）为 StoryFact
增加一个极窄的治理例外：只有 `ambiguous_confirmed_alias` 可以由作者选择“绑定已有实体”或
“保留为独立实体”，且必须保留正文、证据、事实身份、置信度和其他结构字段，修订号严格加一。
任意绕过服务直接修改别名 JSON、过期并发决定或畸形允许列表都会被 SQLite 触发器拒绝。

迁移 `0044_story_planning_selective_acceptance_intent.sql`（Tauri/SQLx 版本 `47`）在正式
大纲写入之前持久保存不含正文的逐项采纳意图，绑定不可变条目 ID、选择摘要、目标大纲修订和
写入前后简介摘要。编辑、拒绝、整体采纳和第二个逐项采纳者必须先通过同一 CAS；中断恢复只
允许完成完全相同的意图，从而避免“大纲已写入但候选仍可被拒绝”的竞态。

迁移 `0045_project_remote_dispatch_leases.sql`（Tauri/SQLx 版本 `48`）新增不含用户内容的
`project_remote_dispatch_leases` 临时表。项目上下文远程 generation、embedding 或 rerank
在派发前由原生 SQLite `BEGIN IMMEDIATE` 事务重新读取项目与全部活动/回收站章节，核对稳定
版本、内容修订、隐私修订、隐私模式、状态、数量和规范指纹；只有精确匹配时才取得租约并开始
联网。租约覆盖完整原生网络生命周期，期间只拒绝向该项目新增或转入 `local_only` 章节以及
删除项目，普通正文、版本和自动保存写入不受阻断。Renderer SQL bridge 不能读取、写入或删除
该表；`non_project` 只允许固定白名单中的无既有项目正文连接/能力探针与建项前创意开头。

迁移 `0046_model_hub_zhipu_glm.sql`（Tauri/SQLx 版本 `49`）以前向表重建扩展 Provider
Registry 的数据库约束，使智谱 GLM 可以作为独立连接类型保存。重建保留已发布字段、连接行和
子表外键；密钥仍只留在操作系统凭据库。旧连接 ID 槽仅兼容读取，新保存使用版本化 owned 槽。它只证明连接类型受支持，不把任何具体 GLM
模型硬编码为永久推荐，也不证明真实账号互操作已通过。

迁移 `0047_context_compilation_exact_provenance.sql`（Tauri/SQLx 版本 `50`）追加三类不可变
关联，把一次上下文编译精确绑定到 generation、Model Hub 调用事实和最终隔离 Candidate。
这些表不复制正文、Prompt、摘录、模型输出或向量；正式桌面运行时以单个 SQLite 事务提交
Candidate 与输出关联，任一关联失败都回滚该 Candidate。

迁移 `0048_candidate_application_intents.sql`（Tauri/SQLx 版本 `51`）为 Candidate 持久保存
任务意图、载荷形状、应用方式和 UTF-16 锚点。历史行保持 `legacy_full_document` 兼容语义；
续写片段只能插入生成时光标，选区改写片段只能替换生成时范围，整章载荷才允许替换全文。
应用意图在创建后不可变，避免把片段误当整章覆盖。

迁移 `0049_memory_governance_audit.sql`（Tauri/SQLx 版本 `52`）追加不可变的项目记忆治理审计。
“忘掉项目记忆”在同一事务中关闭该项目自动学习并排除现有记忆，但保留来源与审计；人工合并
要求作者明确选择两条记录、编辑合并内容、指定保留项，并把另一条标为排除。两种操作都记录
请求及前后快照，不做基于文本相似度的无声自动合并，也不物理删除用户可追溯来源。

迁移 `0050_candidate_revision_authority.sql`（Tauri/SQLx 版本 `53`）为每个 Candidate 增加
单调 `revision`。历史行从 `1` 开始；`ready → ready` 的作者修改，以及
`ready → accepted/rejected/expired` 的决定，都以“状态 + 用户实际看到的 revision”做 CAS。
SQLite 正式提交、浏览器开发存储和多智能体章节候选投影使用同一权限；旧窗口不能修改、拒绝或
接受作者未看过的新版文本。接受前还会重新计算 Candidate 内容 SHA-256，行内容与校验值不一致时
整笔失败并保留正文、版本历史和赢家 Candidate。

迁移 `0051_model_hub_connection_commits.sql`（Tauri/SQLx 版本 `54`）保存不含密钥的连接提交
journal。新密钥先写入版本化 owned 槽，真实连接与目录验证完成后再以单个 SQLite 事务发布连接、目录和 journal 阶段；启动恢复会清理未发布槽或已替换旧槽，且绝不删除任何仍被已发布连接引用的当前槽。API Key 仍不进入数据库。

迁移 `0052`–`0059` 继续采用只向前追加：`0052` 保存连续故事状态的精确路由回执，`0053`
记录反馈发生时的学习策略，`0054` 增加明确反馈幂等身份，`0055` 修正合法历史回执的恢复约束，
`0056` 增加脱敏模型失败诊断，`0057` 补齐内容质量检查任务合同，`0058` 保存原子 Story Settings
导入收据，`0059` 区分费用可估与价格未知。
明确反馈事件、事件时策略、全量证据计数和可见偏好同步由 SQLite 单事务或浏览器单 mutation
完成；501 字以上的自定义反馈在写入前拒绝。连续状态新提交仍要求章节当前版本与内容哈希 CAS，
历史回执只在所属项目、章节、不可变版本和哈希全部匹配时允许恢复。

迁移 `0060`–`0064` 依次追加 Novel Skill registry/snapshot、content-free 付费评测账本、
项目 active 派发租约围栏、精确评测目标/商业授权/预留/盲评合同和内容无关的派发前权威。
`0065_model_invocation_dispatch_boundary.sql` / Tauri `68` 不新建平行账本，只在现有
`model_invocation_facts` 追加可空的 `provider_dispatch_started_at`。它在网络网关调用前立即持久化，
不含 Prompt、正文、输出、凭据或 Provider 响应；恢复中的 `running` 行没有该时间时可结清为
`not_dispatched`，有该时间时必须保守结清为 `ambiguous`，两者都不得因启动恢复而自动重发。

当前共有 167 张应用表：恢复权威白名单为 166 张表，另有 1 张不恢复的临时租约表。`project_remote_dispatch_leases` 是单独的短期网络事实，不进入
恢复白名单；`VACUUM INTO` 一致性备份即使物理包含租约行，恢复事务也明确不复制它，并继续
清空 4 个可重建派生根表。旧网络租约不能借备份恢复成当前网络事实。

### 3.5 Phase 5：可见反馈学习

实际迁移：`packages/data/migrations/0035_writing_feedback_learning.sql`，Tauri/SQLx 版本 `38`。

- `writing_feedback_policies`：项目级是否允许形成偏好，带修订号；
- `writing_feedback_events`：接受、拒绝、重新生成、局部接受、删除、恢复原文和显式反馈的不可变事件；不复制正文或候选内容；
- `writing_preferences`：用户可见的手工或重复反馈偏好，可启停和软删除；
- `writing_preference_revisions`：偏好创建、编辑、启停和删除历史。

因果 What-if 复用 `story_facts` 的 `branch` 状态保存 `inkshadow.causal-what-if.v1` 沙盒结果；
不会新增平行主线表。Model Hub 基础评测复用 `model_evaluation_results`，多 Agent 继续复用既有审查表但读取
确认 StoryFact 和已验证因果图。

### 3.6 仍待决定或实现的数据模型

- POV 严格投影已能绑定取得事件、来源事实、人物、知识键、信息标识和叙事顺序；旧记录缺任一绑定字段时失败关闭。完整人物知识状态（知道/不知道/怀疑/误信）的全书维护体验仍需在真实长篇上继续验证；
- 从自然语言正文持续生成、归并和撤销声纹、剧情线与场景指标的安全抽取任务/收据；
- 图片资产清单、来源/授权和正文引用模型目前尚未建立；本机导出的图片文件不应被当作项目内正式资产。

## 4. 兼容读取与回填

1. 新代码优先读新表；若不存在新记录，再读取 `model_profiles`、`model_role_routes`、
   `story_formal_records` 等旧结构。
2. 首次进入 Model Hub 时创建连接投影，不移动或复制密钥。
3. 旧七类模型角色只生成“待用户确认”的小说任务建议，不直接覆盖用户路由。
4. 旧正式设定和记忆只能经显式回填进入 `legacy + unconfirmed + needs_review`；即使旧名称为
   “正式记录”，在没有新证据与本次用户确认时也不得自动提升为 `formal`。
5. 旧 GraphRAG、Embedding 和统计索引均是可重建投影，不阻塞基础写作；新因果图同样由确认 StoryFact 重建。
6. 多 Agent 的 `project_rule` 引用优先验证确认主分支 StoryFact；既有 L4 记忆只保留兼容读取，不能覆盖新事实。

## 5. 回滚

- 代码回滚只停止读取新表，不删除新表和用户输入。
- 新旧路由同时保留一个兼容周期；旧项目仍可从作品库和历史 URL 打开。
- 若迁移失败，Tauri 必须拒绝启动写事务并引导使用现有备份恢复工具。
- 可选高级能力可通过 Feature Flag 或路由关闭，但 StoryFact、候选、版本、恢复和迁移数据不可随功能关闭而删除。
- `0032`–`0035` 已加入本地备份/恢复顺序；回滚代码时保留这些表与用户决定，恢复新版本后仍可继续读取。
