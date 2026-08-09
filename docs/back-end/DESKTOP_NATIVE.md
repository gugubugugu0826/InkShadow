# InkShadow Desktop 原生层逐文件指引

> 基于源码快照：2026-08-10  
> 文档状态：`SUPPORTING_CURRENT`  
> 应用版本：`0.2.1`；设计基线：`DESIGN v0.3.1b`  
> 覆盖范围：`apps/desktop/src-tauri`、本地 SQLite 原生桥、自动备份、系统凭据库、原生网络、项目密钥、安全更新与系统容量

## 1. 它不是传统“后端”

`apps/desktop/src-tauri` 是和桌面应用一起安装的 Tauri/Rust 原生可信边界，不是远程服务器。它负责 JavaScript 不应直接拥有的本机能力：

```text
React 页面
  → Desktop runtime / packages/data
  → Tauri invoke（59 个受控 command）
  ├─ SQLite：应用配置目录/inkshadow.db
  ├─ OS Credential Store：模型密钥、设备私钥、Cloud Token、团队密钥回执
  ├─ 原生 HTTP：模型服务、Cloud API、更新源
  ├─ 原生文件选择：短期路径票据
  ├─ 自动备份：应用专属目录、租约、清单、文件身份与完整性门禁
  └─ Windows：内存、磁盘、安全更新暂存 ACL
```

关键事实：

- Release `.exe` 使用 Windows GUI subsystem，不显示 CMD；Debug 构建和开发脚本仍可能显示控制台。
- SQLite 使用普通 SQLx SQLite，不是 SQLCipher；不能宣称整个 `inkshadow.db` 文件已加密。
- 同步传输表保存密文，但本地章节、正文和物化数据仍在普通 SQLite 表中。
- 项目数据密钥在生成、解包和恢复时会返回可信 Desktop runtime，因此打包后的前端运行时代码也属于安全边界。

## 2. 构建、窗口和权限配置

| 文件                                                  | 内容                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src-tauri/src/main.rs`                  | 原生进程入口；Release 启用 `windows_subsystem = "windows"` 隐藏控制台，并调用 `inkshadow_desktop_lib::run()`。 |
| `apps/desktop/src-tauri/src/lib.rs`                   | Tauri Builder、共享状态、插件、单实例逻辑和全部 59 个 command 的注册入口。                                     |
| `apps/desktop/src-tauri/Cargo.toml`                   | Rust/Tauri、SQLx SQLite、Reqwest/Rustls、Keyring、HPKE、AES-GCM、Argon2、Ring 和 Windows API 依赖。            |
| `apps/desktop/src-tauri/Cargo.lock`                   | Rust 完整依赖锁文件；由 Cargo 维护。                                                                           |
| `apps/desktop/src-tauri/build.rs`                     | 监听六个 `INKSHADOW_UPDATE_*` 编译期变量并运行 Tauri build。                                                   |
| `apps/desktop/src-tauri/tauri.conf.json`              | `main` 窗口、1440×900、最小 720×560、NSIS/currentUser 和正式 `dist` 目录。                                     |
| `apps/desktop/src-tauri/tauri.dev.conf.json`          | 开发服务器 `127.0.0.1:1420`，只在开发 CSP 增加本地 HTTP/WebSocket。                                            |
| `apps/desktop/src-tauri/tauri.release-gate.conf.json` | 打包前执行 Desktop release 检查并使用 `dist-release`。                                                         |
| `apps/desktop/src-tauri/capabilities/default.json`    | 仅给 `main` 窗口核心、窗口销毁和日志能力；不开放 shell、任意文件系统或任意 HTTP。                              |
| `apps/desktop/src-tauri/gen/schemas/*.json`           | Tauri 自动生成的 ACL/capability schema，不手工编辑。                                                           |
| `apps/desktop/src-tauri/icons/`                       | Desktop、Windows Store、iOS 和 Android 打包图标资产，不包含运行逻辑。                                          |

正式 CSP 只允许自身资源和 Tauri IPC，并禁止 frame、object、form、media 和任意远程 `connect-src`；`style-src` 仍保留 `unsafe-inline`。单实例插件会显示并聚焦已有主窗口。

## 3. 19 个 Rust 源文件

| 文件                                                   | 内容                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `apps/desktop/src-tauri/src/main.rs`                   | Windows GUI subsystem 入口；Release 隐藏控制台。                                                   |
| `apps/desktop/src-tauri/src/lib.rs`                    | 模块组合、Tauri 启动、共享状态、插件和 59 个 command 注册。                                        |
| `apps/desktop/src-tauri/src/local_migrations.rs`       | 把 `packages/data` 与 `packages/story-core` 的 62 个 SQL migration 编译进二进制并交给 SQLx。       |
| `apps/desktop/src-tauri/src/automatic_backup.rs`       | 应用专属自动备份根、所有权标记、租约、清单 CAS、一次性目标票据、完整性核验和受限清理。             |
| `apps/desktop/src-tauri/src/native_sqlite.rs`          | 固定库打开、迁移、查询、写入、事务、备份/恢复受控语句、资源上限和失败关闭。                        |
| `apps/desktop/src-tauri/src/path_tickets.rs`           | 文件选择后的 5 分钟、会话绑定、不可伪造路径票据及文件身份防替换。                                  |
| `apps/desktop/src-tauri/src/network_egress.rs`         | 模型、Cloud 和 updater 共用 DNS 出口策略；远程只到公网，显式 localhost 只到回环。                  |
| `apps/desktop/src-tauri/src/project_keys.rs`           | 设备身份、项目数据密钥、设备/团队 HPKE 信封、团队回执、恢复码和恢复信封。                          |
| `apps/desktop/src-tauri/src/cloud_session.rs`          | 云登录、验证、刷新、登出、Token Keyring、受限 relay、删除凭据请求和团队项目密钥接收。              |
| `apps/desktop/src-tauri/src/secure_updater.rs`         | Ed25519 更新清单、反重放、同源制品下载和 Windows 安全暂存；不执行安装。                            |
| `apps/desktop/src-tauri/src/system_capacity.rs`        | CPU、Windows 物理内存和应用数据卷容量；GPU 容量明确报告未测量。                                    |
| `apps/desktop/src-tauri/src/model_gateway/mod.rs`      | 模型网关模块和 command 重导出。                                                                    |
| `apps/desktop/src-tauri/src/model_gateway/types.rs`    | OpenAI-compatible、Ollama、Anthropic、Gemini 的请求、模型、Embedding、Rerank、生成事件和取消契约。 |
| `apps/desktop/src-tauri/src/model_gateway/error.rs`    | 统一原生错误：稳定码、公开消息、可重试、建议动作和 UUIDv7 request ID。                             |
| `apps/desktop/src-tauri/src/model_gateway/endpoint.rs` | 模型 URL 规范化；远程只 HTTPS，HTTP 只显式回环，并拒绝凭据、query、fragment 和私网目标。           |
| `apps/desktop/src-tauri/src/model_gateway/registry.rs` | 活跃生成注册、重复 ID 阻止和 cancellation token。                                                  |
| `apps/desktop/src-tauri/src/model_gateway/protocol.rs` | OpenAI/Anthropic/Gemini SSE、Ollama NDJSON、模型列表、Embedding 和 Qwen Rerank 的有界解析。        |
| `apps/desktop/src-tauri/src/model_gateway/image.rs`    | OpenAI-compatible base64 PNG 解析、签名/尺寸/体积校验和单次路径票据安全写入。                      |
| `apps/desktop/src-tauri/src/model_gateway/gateway.rs`  | 模型列表、连接检查、Embedding、Qwen Rerank、流式生成、图片生成、事件、超时、限制和取消。           |

## 4. 59 个 Tauri command

详细参数和返回值见 [`../front-end/INTERFACE_REFERENCE.md`](../front-end/INTERFACE_REFERENCE.md)。

| 分组             | 数量 | command                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 自动备份         |    9 | `native_automatic_backup_inspect_root`、`native_automatic_backup_acquire_lease`、`native_automatic_backup_release_lease`、`native_automatic_backup_read_manifest`、`native_automatic_backup_write_manifest`、`native_automatic_backup_prepare_destination`、`native_automatic_backup_inspect_file`、`native_automatic_backup_delete_file`、`native_automatic_backup_cleanup_failed_creation`                             |
| 运行环境         |    1 | `get_runtime_info`                                                                                                                                                                                                                                                                                                                                                                                                       |
| 原生文件选择     |    3 | `native_choose_backup_destination`、`native_choose_restore_source`、`native_choose_pre_restore_backup_destination`                                                                                                                                                                                                                                                                                                       |
| SQLite           |    9 | `native_sqlite_open`、`native_sqlite_select`、`native_sqlite_execute`、`native_sqlite_begin`、`native_sqlite_transaction_select`、`native_sqlite_transaction_execute`、`native_sqlite_commit`、`native_sqlite_rollback`、`native_sqlite_close`                                                                                                                                                                           |
| 模型密钥         |    3 | `save_model_secret`、`get_model_secret_summary`、`delete_model_secret`                                                                                                                                                                                                                                                                                                                                                   |
| 模型网关         |    8 | `list_native_models`、`check_native_model_connection`、`embed_native_model`、`rerank_native_model`、`choose_native_image_destination`、`generate_native_image_to_file`、`start_native_generation`、`cancel_native_generation`                                                                                                                                                                                            |
| 系统容量         |    1 | `inspect_native_model_capacity`                                                                                                                                                                                                                                                                                                                                                                                          |
| 安全更新         |    3 | `inspect_secure_update_configuration`、`check_for_signed_update`、`stage_signed_update`                                                                                                                                                                                                                                                                                                                                  |
| 项目密钥         |    9 | `create_device_identity`、`get_device_identity_status`、`generate_project_data_key`、`wrap_project_data_key_for_device`、`unwrap_project_data_key_for_device`、`rewrap_project_data_key_for_team_recipients`、`create_project_recovery_kit`、`verify_project_recovery_kit`、`recover_project_data_key`                                                                                                                   |
| 云会话与团队密钥 |   12 | `login_cloud_identity`、`verify_cloud_identity_email`、`refresh_cloud_session`、`get_cloud_session_status`、`send_cloud_api_request`、`send_cloud_deletion_credential_request`、`accept_current_device_team_project_key_envelope_from_cloud`、`inspect_stored_team_project_key_receipt`、`open_stored_team_project_key_receipt`、`remove_stored_team_project_key_receipt`、`logout_cloud_session`、`clear_cloud_session` |

唯一主动事件为 `model-generation-event`，状态为 `started`、`delta`、`completed`、`cancelled` 或 `failed`。事件不会包含 Prompt 或 API Key。完成事件可声明原生响应是否实际流式；失败事件只携带
扁平、有界的 request ID、HTTP/终止原因、可见内容长度、推理是否出现/长度、流式标记和 usage，
不携带可见回答、推理正文或供应商原始响应。

## 5. 原生 SQLite

### 5.1 打开和迁移

- 数据库固定为 Tauri `app_config_dir()/inkshadow.db`，页面不能指定其他数据库路径。
- 打开时强制 `foreign_keys=ON`、WAL、`synchronous=NORMAL`、5 秒 busy timeout。
- 配置和全部 migration 验证成功后才返回随机会话 token。
- migration 校验和不一致会报 `SQLITE_MIGRATION_INTEGRITY_FAILED` 并停止，而不是覆盖用户数据。
- 当前前向上限为 Data `0059_generation_preflight_cost_status.sql` / Tauri `62`；Data 与 story-core
  合并为一个原生连续序列，所以两个编号不要求相同。尾部三次只向前追加分别是：`0057`/Tauri
  `60` 补齐 Model Hub 的 `content_quality_check` 路由合同，`0058`/Tauri `61` 保存原子故事设定
  导入收据，`0059`/Tauri `62` 记录生成费用是否可估而不因价格未知阻断写作。

### 5.2 SQL 与结果边界

- SQL 最大 1 MiB；最多 16,000 个绑定值、32 MiB 绑定内容。
- 单单元格最大 8 MiB；结果最多 64 MiB、100,001 行、512 列。
- SQLite INTEGER 必须落在 JavaScript 安全整数范围。
- 读取只允许 `SELECT`、`WITH`、`VALUES`、`EXPLAIN` 和有限只读 PRAGMA。
- 拒绝多语句和 WebView 直接执行事务控制、`ATTACH`、`DETACH`、`VACUUM`。
- Renderer SQL bridge 对 `project_remote_dispatch_` 标识符前缀一律拒绝读写；租约只能由原生网关的内部直连路径管理。
- `database_list` 等路径输出会改写为 `native://...`。
- 普通 execute 不是按业务表的授权防火墙；受信任 WebView 仍可执行许多单条 DML/DDL，发布代码完整性很重要。

### 5.3 事务

- 同时只允许一个事务；读事务使用 `BEGIN DEFERRED + query_only ON`，写事务使用 `BEGIN IMMEDIATE`。
- 空闲 2 分钟或总寿命 15 分钟自动回滚。
- commit 状态不确定、rollback 失败或 PRAGMA 恢复失败时关闭整个 session。
- TypeScript 适配器串行原生调用并禁止嵌套事务。

### 5.4 备份与恢复

- WebView 只获得短期票据，不获得真实路径。
- 备份目标必须不存在；恢复源必须是普通文件；票据 TTL 5 分钟。
- 使用 `VACUUM INTO` 创建一致备份。
- 恢复前检查 integrity、foreign key 和主库/备份 schema 完全一致。
- 当前作者数据口径为 143 张应用表：恢复契约复制其中 142 张可恢复表，1 张
  `project_remote_dispatch_leases` 临时远程派发租约表明确不恢复；4 个可重建派生根表会清空后重建。
- 一致性备份可能物理包含不含用户内容的 `project_remote_dispatch_leases` 临时表，但恢复事务明确不复制该表，不能把备份中的旧租约恢复为当前网络事实。
- 新增权威表时必须同步维护恢复表清单、删除顺序、插入顺序和测试。

### 5.5 自动备份

- 自动备份根固定在 Tauri 应用数据目录的 `automatic-backups/v1`，首次使用写入产品所有权标记；页面不能指定其他根目录。
- TypeScript 运行时按本地 03:00 槽位调度，启动时补最近一次漏跑，存活期间每小时检查，默认保留 30 天。
- 原生层使用带过期时间的租约和修订号清单，只有清单中 `creating` 条目能取得一次性备份目标票据。
- 清理不枚举任意目录。只有直系路径、严格文件名、根标记、租约、清单状态、到期时间、文件身份、SQLite 完整性、大小与 SHA-256 全部匹配时才允许删除。
- 手动备份不进入自动备份清单；浏览器开发模式没有原生备份能力，会明确返回不可用而不是伪造文件。

## 6. 62 个原生 migration

原生版本号把 59 个 `data` migration 与 3 个 `story-core` migration 合并为一个连续序列，因此不等于单个目录中的文件名前缀。

| 原生版本 | SQL 来源                                                                             | 内容                                                             |
| -------: | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
|        1 | `packages/data/migrations/0001_core.sql`                                             | 项目、章节、版本、草稿、AI 候选和审计。                          |
|        2 | `packages/data/migrations/0002_tasks_notifications.sql`                              | 后台任务和通知。                                                 |
|        3 | `packages/story-core/migrations/0001_story_core.sql`                                 | 大纲、正式记录、时间线、评审、记忆和 What-if。                   |
|        4 | `packages/data/migrations/0003_sync_access.sql`                                      | 密文同步、访问快照和授权缓存。                                   |
|        5 | `packages/data/migrations/0004_model_profiles.sql`                                   | 非秘密模型配置。                                                 |
|        6 | `packages/story-core/migrations/0002_materials.sql`                                  | 素材和引用。                                                     |
|        7 | `packages/data/migrations/0005_ai_generation_governance.sql`                         | 定价、预算和生成记录。                                           |
|        8 | `packages/data/migrations/0006_search_index.sql`                                     | FTS 搜索投影。                                                   |
|        9 | `packages/data/migrations/0007_model_routing_usage.sql`                              | 路由、尝试用量和延期生成。                                       |
|       10 | `packages/data/migrations/0008_project_key_lifecycle.sql`                            | 设备公钥、项目密钥版本和信封。                                   |
|       11 | `packages/data/migrations/0009_device_identity_names.sql`                            | 本地设备显示名。                                                 |
|       12 | `packages/data/migrations/0010_sync_inbox.sql`                                       | 收件箱、远程 checkpoint 和设备序列。                             |
|       13 | `packages/data/migrations/0011_cloud_project_key_checkpoints.sql`                    | 云项目密钥 checkpoint。                                          |
|       14 | `packages/data/migrations/0012_cloud_project_key_publications.sql`                   | 崩溃安全发布状态。                                               |
|       15 | `packages/data/migrations/0013_sync_snapshot_staging.sql`                            | 原子快照暂存。                                                   |
|       16 | `packages/data/migrations/0014_sync_protocol_v2_object_types.sql`                    | 同步协议 v2 和对象类型。                                         |
|       17 | `packages/data/migrations/0015_sync_materialization_authority.sql`                   | 注册、明文物化、冲突和投影任务。                                 |
|       18 | `packages/data/migrations/0016_sync_snapshot_materialization_receipts.sql`           | 快照物化回执。                                                   |
|       19 | `packages/data/migrations/0017_sync_projection_account_authority.sql`                | 投影任务绑定账户权威。                                           |
|       20 | `packages/data/migrations/0018_sync_incremental_terminal_observations.sql`           | 增量拉取终态观察。                                               |
|       21 | `packages/data/migrations/0019_cloud_deletion_journal.sql`                           | 云删除恢复日志。                                                 |
|       22 | `packages/data/migrations/0020_graph_rag_projection.sql`                             | 可重建 Graph RAG 投影。                                          |
|       23 | `packages/story-core/migrations/0003_ideation.sql`                                   | 构思草稿。                                                       |
|       24 | `packages/data/migrations/0021_search_vector_index.sql`                              | 本地精确向量索引。                                               |
|       25 | `packages/data/migrations/0022_team_project_key_receipts.sql`                        | 团队项目密钥回执元数据。                                         |
|       26 | `packages/data/migrations/0023_authoritative_story_graph_epoch.sql`                  | 权威故事图 epoch。                                               |
|       27 | `packages/data/migrations/0024_multi_agent_review.sql`                               | 多智能体评审。                                                   |
|       28 | `packages/data/migrations/0025_governed_creative_extensions.sql`                     | 翻译、短剧、预算、同意和候选。                                   |
|       29 | `packages/data/migrations/0026_team_template_applications.sql`                       | 团队模板本地应用回执。                                           |
|       30 | `packages/data/migrations/0027_authoritative_extraction.sql`                         | 权威抽取任务、评估和决定。                                       |
|       31 | `packages/data/migrations/0028_fine_tuning_governance.sql`                           | 微调数据、审批、任务、评估、部署和审计。                         |
|       32 | `packages/data/migrations/0029_community_marketplace_installs.sql`                   | 社区市场安装记录。                                               |
|       33 | `packages/data/migrations/0030_creative_journeys.sql`                                | 可恢复的一句话开书与导入创作旅程。                               |
|       34 | `packages/data/migrations/0031_model_hub.sql`                                        | Model Hub 连接、目录、能力、路由、策略和调用事实。               |
|       35 | `packages/data/migrations/0032_unified_story_facts.sql`                              | 统一、证据化 StoryFact 与修订/旧数据链接。                       |
|       36 | `packages/data/migrations/0033_causal_event_graph.sql`                               | 可重建的因果事件图投影。                                         |
|       37 | `packages/data/migrations/0034_context_compilation_trace.sql`                        | 不含正文的上下文编译历史。                                       |
|       38 | `packages/data/migrations/0035_writing_feedback_learning.sql`                        | 用户可见、可控的写作反馈学习。                                   |
|       39 | `packages/data/migrations/0036_story_planning_candidates.sql`                        | 只供审阅的 AI 剧情规划候选。                                     |
|       40 | `packages/data/migrations/0037_model_hub_expert_options.sql`                         | 不含秘密的 Model Hub 专家连接元数据。                            |
|       41 | `packages/data/migrations/0038_private_chapters.sql`                                 | 章节级仅本机隐私门禁与导出默认排除。                             |
|       42 | `packages/data/migrations/0039_project_seeds.sql`                                    | 三条创建旅程共享、可修订的项目创作种子。                         |
|       43 | `packages/data/migrations/0040_chapter_validation_snapshots.sql`                     | 绑定不可变章节版本的确定性检查快照。                             |
|       44 | `packages/data/migrations/0041_story_planning_selective_acceptance.sql`              | 规划候选目标基线与逐项采纳回执。                                 |
|       45 | `packages/data/migrations/0042_chapter_validation_snapshot_delete_cascade.sql`       | 修复检查快照在章节/项目删除与恢复时的级联语义。                  |
|       46 | `packages/data/migrations/0043_story_fact_entity_alias_resolution.sql`               | 只允许受审计、带修订的实体别名人工消歧。                         |
|       47 | `packages/data/migrations/0044_story_planning_selective_acceptance_intent.sql`       | 正式大纲变更前持久预留逐项采纳意图。                             |
|       48 | `packages/data/migrations/0045_project_remote_dispatch_leases.sql`                   | 项目上下文远程派发的内容无关租约、隐私变更与删除防护。           |
|       49 | `packages/data/migrations/0046_model_hub_zhipu_glm.sql`                              | 前向重建 Provider 连接约束，允许独立 GLM 连接类型。              |
|       50 | `packages/data/migrations/0047_context_compilation_exact_provenance.sql`             | 上下文编译到 generation、调用事实和最终 Candidate 的不可变关联。 |
|       51 | `packages/data/migrations/0048_candidate_application_intents.sql`                    | Candidate 任务语义、载荷形状、应用方式与 UTF-16 锚点。           |
|       52 | `packages/data/migrations/0049_memory_governance_audit.sql`                          | 项目记忆忘却和人工合并的不可变治理审计。                         |
|       53 | `packages/data/migrations/0050_candidate_revision_authority.sql`                     | Candidate 单调修订、CAS 决定和内容校验权威。                     |
|       54 | `packages/data/migrations/0051_model_hub_connection_commits.sql`                     | 不含密钥的 Model Hub 跨存储提交与补偿 journal。                  |
|       55 | `packages/data/migrations/0052_continuous_story_state_route_receipts.sql`            | 连续故事状态提取的版本/路由完成收据。                            |
|       56 | `packages/data/migrations/0053_writing_feedback_learning_policy_context.sql`         | 反馈发生时学习策略与自定义意见哈希簇。                           |
|       57 | `packages/data/migrations/0054_writing_feedback_explicit_idempotency.sql`            | 明确反馈幂等身份与反馈/偏好原子同步边界。                        |
|       58 | `packages/data/migrations/0055_continuous_story_state_historical_route_receipts.sql` | 合法历史状态回执的备份恢复约束。                                 |
|       59 | `packages/data/migrations/0056_model_hub_failure_diagnostics.sql`                    | 能力扫描与调用事实的可空、脱敏 AI 失败诊断字段和索引。           |
|       60 | `packages/data/migrations/0057_model_hub_content_quality_task.sql`                   | 为三张 Model Hub 表前向补齐内容质量检查任务合同。                |
|       61 | `packages/data/migrations/0058_story_settings_import_receipts.sql`                   | 原子故事设定导入、冲突处理和可验证撤销所需的收据。               |
|       62 | `packages/data/migrations/0059_generation_preflight_cost_status.sql`                 | 区分可估费用与价格未知，后者只提示而不阻断基础写作。             |

规则：SQL 通过 `include_str!` 编译进二进制；缺失迁移不忽略、迁移加锁且逐条事务执行。已发布 migration 的内容、描述和顺序不能修改，只能新增。

## 7. 模型网关

Model Hub Provider Registry 当前区分 OpenAI、DeepSeek、阿里云百炼/Qwen、火山方舟/豆包、
Google Gemini、Anthropic Claude、智谱 GLM、Ollama 和自定义 OpenAI-compatible。Registry 是
供应商连接与能力证据层；Rust 网关按实际协议执行请求。普通模式使用预设并隐藏底层参数，只有
专家模式可以在安全限制内覆盖相对路径、Header 名、超时和重试。模型推荐依赖能力与评测，不按
名称永久绑定供应商。

支持的当前代码路径：

- OpenAI-compatible：模型列表、流式文本生成、Embedding；自定义兼容连接可在专家模式覆盖受限相对路径和单一认证 Header 名，Header 值仍在 OS 凭据库。
- DeepSeek 文本能力探针：Provider Registry 为固定无作品内容探针声明禁用思考，网关映射为
  `thinking: {"type":"disabled"}`；共享探针预算为 64 token。该覆盖不应用于普通正文生成，也不
  依赖具体模型名称。
- Ollama：`/api/tags`、`/api/chat` NDJSON、`/api/embed`。
- Anthropic：官方模型目录和 Messages SSE 文本生成。
- Gemini：官方模型目录、流式文本生成和批量 Embedding。
- 阿里云百炼/Qwen Rerank：仅北京地域、Workspace 绑定的已验证 OpenAI-compatible `/reranks` 协议。
- 图片：当前最小路径只接受受限 OpenAI-compatible base64 PNG，并写入用户先选择的新文件。

安全和资源边界：

- 远程 endpoint 只允许 HTTPS；HTTP 仅显式 localhost/回环。
- 拒绝 URL 凭据、query、fragment、路径歧义、重定向、系统代理和私网 DNS。
- 模型密钥存入系统凭据库；页面只能看到是否已配置及末四位。
- 新保存使用与连接 ID 解耦的版本化 `keyring:model-hub:<slot>` owned 引用；旧 `keyring:legacy-model-profile:<providerId>` 仅兼容读取。连接与目录只在真实验证后原子发布，启动补偿绝不删除任何已发布连接仍引用的当前槽。
- 生成输入最大 1 MiB、最多 256 条 message；响应最大 8 MiB，最长 10 分钟，流空闲 45 秒。
- Embedding 最多 64 条，总输入 512 KiB，单条 64 KiB，响应 8 MiB。
- Rerank 最多 64 条候选，限制查询/单条/总字节；模型返回索引、分数和协议必须严格匹配。
- Provider 的原始错误正文不会直接暴露给页面。
- OpenAI-compatible SSE 的 `reasoning_content` 不会作为可见 `delta` 发出；解析器只保留脱敏的
  出现标记和有界长度。同一帧会先处理可见 `content` 与 usage，再把 `finish_reason = "length"`
  归一化为 `MODEL_OUTPUT_TRUNCATED`，避免丢失已经实际收到的可见文本。
- `MODEL_OUTPUT_TRUNCATED` 对普通正文、续写、改写和 Candidate 始终是失败。只有固定文本能力
  探针可以在截断前已有非空可见文本时把扫描记为 `partial` 并证明可见文本能力；只有推理或空
  文本不能提交支持证据。
- 每个 generation、embedding、rerank 请求都必须显式声明 `dispatchScope`。`non_project` 只允许固定白名单中的无既有项目正文连接/能力探针与建项前创意开头；其余项目内容必须携带 `project_context` 权威回执。
- 远程 `project_context` 在发出任何正文前以 `BEGIN IMMEDIATE` 原子重验项目存在性、章节集合、稳定版本/修订、隐私修订和规范指纹；不匹配即失败关闭。
- 指纹复核成功后，原生网关为完整网络 Future 持有不含正文的派发租约，生成、Embedding 与 Rerank 的成功、失败、取消和 panic 路径都在网络生命周期结束后释放。租约期间仅阻止向该项目新增/转入 `local_only` 章节及删除项目，普通正文编辑、版本和自动保存继续可写。

Qwen 远程重排还必须经过 Model Hub 的用户远程内容同意、ready 连接、OS 凭据、能力、隐私、
费用和配置指纹门禁；任何失败都由 Desktop runtime 保留本地确定性排序。Rust 的协议测试和
本地模拟服务通过不等于真实百炼账号已验收，当前尚无真实 Qwen Key 的线上端到端证据。

## 8. 设备身份与项目密钥

系统凭据库服务名为 `com.inkshadow.desktop`，保存：

- `device:<UUIDv7>`：设备 P-256 私钥；
- `cloud:active-session`：云会话和 token；
- `model:<providerId>`：模型秘密；
- `team_project_key_receipt_v1_<sha256>`：团队项目密钥回执；
- `secure-update-checkpoint:v1:...`：更新反重放检查点。

主要算法：

- 设备密钥：DHKEM-P256-HKDF-SHA256；
- 设备/团队信封：认证 HPKE + AES-128-GCM；
- 项目数据密钥：32 字节；
- 恢复信封：Argon2id + AES-256-GCM；
- 恢复码前缀：`INK1_`。

创建设备身份是幂等操作。团队重包最多 10,000 个接收设备。恢复码会返回用户，原生层不会代为保管。系统凭据库不可用时相关能力失败关闭。

## 9. Cloud 会话与原生 relay

- access/refresh token 只存系统凭据库；页面状态不返回 token。
- 会话更新使用 `sessionId + recordGeneration` CAS，防止旧请求覆盖新会话。
- Release 只允许 HTTPS；Debug 只有显式开启才允许 loopback HTTP。
- relay 禁止页面传 `Authorization`，也拒绝任意层级的 password/token 等敏感字段。
- 请求 ID 必须是 UUIDv7，需要写幂等的操作必须有合法 `Idempotency-Key`。
- 响应若泄漏 token 或秘密字段也会被拒绝。

通用 relay 使用明确 allowlist，不是任意 HTTP 客户端。Enterprise SSO、团队评审、AI 用量、团队模板和部分市场管理接口虽然服务端存在，当前不能因此宣称 Desktop 已可调用。

需要密码的删除请求走专用 `send_cloud_deletion_credential_request`；输入在释放时清零。团队项目密钥也使用专用命令完成两次版本检查、解封和系统凭据库存储。

## 10. 安全更新

当前 updater 只“验证并暂存”，不会自动安装：

- 使用编译期 channel、manifest URL、主/次 Ed25519 key。
- 验证规范 JSON、签名、product、channel、target、sequence、发布时间和到期时间。
- 系统凭据库 checkpoint 防回退、同序列篡改和明显时钟回拨。
- 制品必须与 manifest 同源 HTTPS、为 Windows NSIS、声明需 Authenticode、不超过 2 GiB，且长度/SHA-256 完全一致。
- Windows 暂存目录限制为当前用户、SYSTEM 和 Administrators，并拒绝 reparse point。
- 当前 `installation_allowed=false`、`authenticode_status=not_verified`；不会验证发布者，也不会执行安装器。
- 非 Windows 安全暂存失败关闭。

## 11. 系统容量

`inspect_native_model_capacity` 返回逻辑 CPU、Windows 物理内存、应用数据卷容量。GPU 显存固定为 `unavailable / gpu_capacity_not_measured`；非 Windows 内存和磁盘查询当前未实现。它只是提示，不是模型兼容性或 GPU 加速承诺。

## 12. 当前限制清单

1. Debug 二进制或开发脚本可能显示控制台，只有 Release GUI 构建隐藏。
2. `inkshadow.db` 不是 SQLCipher。
3. SQLite 桥限制 SQL 形态和资源，但不是业务表级数据库防火墙。
4. Cloud relay 只允许明确列出的路由。
5. 模型网关已有 OpenAI-compatible、Ollama、Anthropic、Gemini 和窄范围 Qwen Rerank 路径，但真实供应商凭据、区域差异、配额和长期稳定性仍需逐家实测。
6. GPU 容量未检测，非 Windows capacity 未实现。
7. updater 不验证 Authenticode 发布者、不执行安装。
8. 已发布 migration 不能重写，只能新增。
9. 新增权威表必须更新备份恢复契约。
10. OS Credential Store 不可用时，模型、设备、Cloud、团队密钥和更新检查点均失败关闭。
11. 云功能仍受服务部署、Feature Flag、账户权限和原生 allowlist 共同约束。
