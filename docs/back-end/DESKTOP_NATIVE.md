# InkShadow Desktop 原生层逐文件指引

> 基于源码快照：2026-08-30  
> 文档状态：`SUPPORTING_CURRENT`  
> 当前发布目标：`0.2.16`；当前源码迁移上限 Data `0082`／Tauri `85`，本轮没有新增迁移；候选提交、安装包、标签和 Release 结果以最终发布证据为准；设计基线：`DESIGN v0.3.1b`  
> 覆盖范围：`apps/desktop/src-tauri`、本地 SQLite 原生桥、自动备份、系统凭据库、原生网络、项目密钥、安全更新与系统容量

## 0. 0.2.16 当前事实

- F17 在供应商内容已经返回后，失败于桌面生产 SQLite 隔离结果提交：已发布 `0080` 要求新选区结果保存准确动作，而提交单元遗漏该列。当前实现把四项动作贯穿查询、写入和幂等比较；原生迁移、守卫和校验值保持不变。
- 本地提交失败且已有可见片段时，页面离开边界允许作者复制或明确放弃片段后释放会话。原生发送回执和调用事实不被删除或伪装成零发送，正文、不可变版本和历史候选不被改写，自动重试保持为零。
- 章节隐私持久化仍通过现有 SQLite 权威行、预期修订和同步清理边界；只有提交成功才更新页面。私密章节仍在原生网络请求之前失败关闭，不要求配置本地模型才可设为私密。
- 示例身份、技能任务范围、检查准备和通知隐藏均复用既有生产表与受控适配器。0.2.16 没有新增原生命令或数据库迁移。
- 当前源码保持 Data `0082_author_recovery_records.sql`／Tauri `85`；v0.2.15 及更早迁移字节、校验和与发布对象保持不变。
- 当前自动化没有执行真实供应商请求、真实 Windows 凭据交互或 0.2.16 安装程序人工验证；临时 SQLite、可控 HTTP 和浏览器回归不得表述为真实安装结论。

## 0.1 0.2.15 历史事实

- 开书调度在渲染层先保存可恢复旅程和稳定方案槽位，再经过资料、隐私、连接、模型与费用检查；原生模型网关只有在调用标识、连接、目录项、修订、范围与隐私边界全部核对后，才在 SQLite 写入不含作品内容的发送回执并开始网络请求。发送后的不确定结果不会自动重发，成功结果仍只保存为隔离建议。
- 作者明确开启的写作技能会先编译为有界方法段，并在 Provider 发送前提交采用快照；快照把技能身份、版本、项目、任务和调用连成同一审计链。原生层不解释或自行启用技能，只执行已通过上层最终身份围栏的请求。
- F10 的文字检查调用 `start_native_generation`，语义向量检查调用 `embed_native_model`。向量请求使用供应商的向量端点、固定无作品内容输入、零自动重试和同一调用回执；原生响应还要经过模型、数量、维度和数值完整性核对，不能用文字生成成功替代向量能力证明。
- U8 编辑失败活动连接时不读取或回填密钥原文，未明确输入新密钥就沿用既有 Keyring 引用；持久化和重试均携带加载时连接修订，修订冲突在网络前失败。成功与失败会分别形成准确连接状态，退役命令不会被“编辑并重试”隐式触发。
- 导出安全边界包含 `native_choose_export_destination`、`native_write_export_artifact` 和 `native_open_export_artifact`。前两者以五分钟单次票据、目录和目标身份复核、64 MiB 上限、临时文件同步、原子安装及最终 SHA-256 回读保护落盘；打开命令只允许规范化后的现有普通文件和受支持扩展名，并把路径作为独立进程参数传递，不接受 shell 文本。
- 当前源码沿用已提交的 Data `0082_author_recovery_records.sql`／Tauri `85`，用于备份兼容的作者恢复记录；本轮后续工作树没有再新增迁移。v0.2.14 及更早迁移字节、校验和与发布保持不变。
- 当前自动化没有执行真实供应商请求、真实 Windows 凭据交互或 0.2.15 安装程序人工验证；本地 HTTP、SQLite 和网关测试不得表述为真实服务或真实安装结论。

`v0.2.6` 已冻结 Tauri `74`、SQLite 重载恢复、自动备份清单第 2 版和能力验证调用回执。
`v0.2.7` 只向前追加 Data `0072`–`0075` / Tauri `75`–`78`，并已随最终候选提交冻结公开；
原生层、最终候选、远端门禁和未签名打包已通过，真实供应商、最终安装程序真机与系统百分之二百缩放仍未完成。
历史隔离 Windows 聚焦结果继续只绑定 `722e67e`，不能外推为当前安装程序验证。
Data `0078_generation_attempt_prose_invocation.sql` / Tauri `81` 已随 v0.2.12 冻结。0.2.14 只向前新增 `0079_story_fact_evidence.sql`／Tauri `82`、`0080_candidate_selection_action.sql`／Tauri `83` 和证据校验性能修复 `0081`／Tauri `84`；原生保存对话框、外部打开、真实 Windows 凭据管理器和安装版升级恢复尚未执行。

## 1. 它不是传统“后端”

`apps/desktop/src-tauri` 是和桌面应用一起安装的 Tauri/Rust 原生可信边界，不是远程服务器。它负责 JavaScript 不应直接拥有的本机能力：

```text
React 页面
  → Desktop runtime / packages/data
  → Tauri invoke（61 个受控 command）
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
| `apps/desktop/src-tauri/src/lib.rs`                   | Tauri Builder、共享状态、插件、单实例逻辑和全部 61 个 command 的注册入口。                                     |
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

## 3. 20 个 Rust 源文件

| 文件                                                   | 内容                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `apps/desktop/src-tauri/src/main.rs`                   | Windows GUI subsystem 入口；Release 隐藏控制台。                                                   |
| `apps/desktop/src-tauri/src/lib.rs`                    | 模块组合、Tauri 启动、共享状态、插件和 61 个 command 注册。                                        |
| `apps/desktop/src-tauri/src/local_migrations.rs`       | 把 `packages/data` 与 `packages/story-core` 的 85 个 SQL migration 编译进二进制并交给 SQLx。       |
| `apps/desktop/src-tauri/src/automatic_backup.rs`       | 应用专属自动备份根、所有权标记、租约、清单第 2 版、独立快照创建、完整性核验和受限清理。            |
| `apps/desktop/src-tauri/src/native_export_artifact.rs` | 导出保存对话框、一次性目标票据、目标身份复核、无覆盖竞态写入及落盘后大小/SHA 回读验证。            |
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

## 4. 61 个 Tauri command

详细参数和返回值见 [`../front-end/INTERFACE_REFERENCE.md`](../front-end/INTERFACE_REFERENCE.md)。

| 分组             | 数量 | command                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 自动备份         |    8 | `native_automatic_backup_inspect_root`、`native_automatic_backup_acquire_lease`、`native_automatic_backup_release_lease`、`native_automatic_backup_read_manifest`、`native_automatic_backup_write_manifest`、`native_automatic_backup_create_verified`、`native_automatic_backup_inspect_file`、`native_automatic_backup_delete_file`                                                                                    |
| 运行环境         |    1 | `get_runtime_info`                                                                                                                                                                                                                                                                                                                                                                                                       |
| 原生文件选择     |    3 | `native_choose_backup_destination`、`native_choose_restore_source`、`native_choose_pre_restore_backup_destination`                                                                                                                                                                                                                                                                                                       |
| SQLite           |    9 | `native_sqlite_open`、`native_sqlite_select`、`native_sqlite_execute`、`native_sqlite_begin`、`native_sqlite_transaction_select`、`native_sqlite_transaction_execute`、`native_sqlite_commit`、`native_sqlite_rollback`、`native_sqlite_close`                                                                                                                                                                           |
| 模型密钥         |    3 | `save_model_secret`、`get_model_secret_summary`、`delete_model_secret`                                                                                                                                                                                                                                                                                                                                                   |
| 模型网关         |    9 | `list_native_models`、`check_native_model_connection`、`embed_native_model`、`rerank_native_model`、`choose_native_image_destination`、`generate_native_image_to_file`、`start_native_generation`、`cancel_native_generation`、`reconcile_native_model_dispatch_leases`                                                                                                                                                  |
| 导出文件保存     |    3 | `native_choose_export_destination`、`native_write_export_artifact`、`native_open_export_artifact`                                                                                                                                                                                                                                                                                                                        |
| 系统容量         |    1 | `inspect_native_model_capacity`                                                                                                                                                                                                                                                                                                                                                                                          |
| 安全更新         |    3 | `inspect_secure_update_configuration`、`check_for_signed_update`、`stage_signed_update`                                                                                                                                                                                                                                                                                                                                  |
| 项目密钥         |    9 | `create_device_identity`、`get_device_identity_status`、`generate_project_data_key`、`wrap_project_data_key_for_device`、`unwrap_project_data_key_for_device`、`rewrap_project_data_key_for_team_recipients`、`create_project_recovery_kit`、`verify_project_recovery_kit`、`recover_project_data_key`                                                                                                                   |
| 云会话与团队密钥 |   12 | `login_cloud_identity`、`verify_cloud_identity_email`、`refresh_cloud_session`、`get_cloud_session_status`、`send_cloud_api_request`、`send_cloud_deletion_credential_request`、`accept_current_device_team_project_key_envelope_from_cloud`、`inspect_stored_team_project_key_receipt`、`open_stored_team_project_key_receipt`、`remove_stored_team_project_key_receipt`、`logout_cloud_session`、`clear_cloud_session` |

导出操作分成“选择目标”“写入制品”和“打开或定位文件”三个原生命令。选择成功只签发五分钟、单次消费且绑定
格式、媒体类型、规范父目录与既有目标身份的 ticket；取消不会签发 ticket，也不会写文件。写入前
再次核对父目录与目标身份，使用临时文件同步落盘后，以 hard-link 新建语义或 Windows
`ReplaceFileW` 原子安装，避免竞态覆盖；随后从最终路径回读并复核字节数与 SHA-256。成功回执
只返回绝对 `path`、`fileName`、`format`、`byteLength`、`status=success` 和 `verified=true`；失败使用
稳定公开错误且不泄漏目标路径。打开命令只接受规范化后的现有普通文件和 `txt`、`md`、`json`、
`epub`、`docx`、`pdf` 扩展名，并把路径作为独立参数交给系统文件管理器。真实 Windows 保存对话框
和外部打开仍需安装程序人工验收。

唯一主动事件为 `model-generation-event`，状态为 `started`、`delta`、`completed`、`cancelled` 或 `failed`。事件不会包含 Prompt 或 API Key。完成事件可声明原生响应是否实际流式；失败事件只携带
扁平、有界的 request ID、HTTP/终止原因、可见内容长度、推理是否出现/长度、流式标记和 usage，
不携带可见回答、推理正文或供应商原始响应。

## 5. 原生 SQLite

### 5.1 打开和迁移

- 数据库固定为 Tauri `app_config_dir()/inkshadow.db`，页面不能指定其他数据库路径。
- 打开时强制 `foreign_keys=ON`、WAL、`synchronous=NORMAL`、5 秒 busy timeout。
- 配置和全部 migration 验证成功后才返回随机会话 token。
- migration 校验和不一致会报 `SQLITE_MIGRATION_INTEGRITY_FAILED` 并停止，而不是覆盖用户数据。
- 当前工作树前向上限为 Data `0082_author_recovery_records.sql` / Tauri `85`；
  82 个 Data migration 与 3 个 story-core migration 合并为一个原生连续序列，所以目录前缀与
  原生版本不要求相同。`0066`–`0068` / Tauri `69`–`71` 依次追加写作体验偏好与 Provider 披露
  grant、有界一致性调查四表，以及只统计 active grant 的上限修复。`0069` / Tauri `72` 在模型
  step 上预留 content-free invocation UUID；账本 INSERT 会在同一 SQLite 语句中绑定 step 和
  context trace，关闭账本创建与 renderer 回调之间的崩溃窗口。`0070` / Tauri `73` 为可重建
  搜索投影追加章节、场景、事件、段落、对话与 StoryFact 证据等多粒度范围、UTF-16 锚点、
  权威性、隐私与 currentness 字段；旧行保持 `legacy_unknown`，必须重建后才可作为当前范围使用。
  `0071` / Tauri `74` 为固定能力验证新增独立调用任务，并让能力证据可空、唯一地绑定同一目录项
  的终态调用记录；迁移前后既有调用行数必须一致。
  `0072` / Tauri `75` 为隔离结果增加不可变用途并禁止方向选项被接受为正文；`0073` / Tauri
  `76` 收紧用户故事事实内容修订和治理转换，同时保留事实身份、来源证据和递增修订。
  `0074` / Tauri `77` 在不可变章节版本上保存本地故事资料整理责任，旧行默认关闭且不可改写；
  `0075` / Tauri `78` 在生成尝试上保存隐私快照版本、隐私策略、数据去向和同一次模型调用标识，
  迁移前旧行保留空值，新行缺失、部分缺失、关联不一致或后续改写均失败关闭。
  `0076` / Tauri `79` 为直接模式本地故事事实增加带审计的作者修订；`0077` / Tauri `80` 增加
  不含作品正文的项目显示标识与修订历史。两项均已随 v0.2.9 冻结；0.2.10 与 0.2.11 均没有新增迁移。
  `0078` / Tauri `81` 不新增字段或表，只扩展 `0075` 的不可变生成尝试隐私守卫，使 `continuation` 和 `prose_generation` 均可保存精确 Model Hub 调用标识；`0079` / Tauri `82` 追加不可变故事事实多证据关系；`0080` / Tauri `83` 为新选区隔离结果保存不可变准确动作；`0081` / Tauri `84` 只替换尚未发布的证据插入保护触发器实现，保持校验条件并缩短长正文扫描；`0082` / Tauri `85` 追加备份兼容的作者恢复记录。本轮后续工作树未再新增迁移，v0.2.14 及更早迁移字节和校验保持原样。
- 启动恢复以 `provider_dispatch_started_at` 为网络边界：发送前中断把 running ledger 结清为
  `cancelled`、run 结清为 `not_dispatched`；发送后中断把 ledger 结清为 `timed_out`、run 结清为
  `ambiguous`。两者都会把非终态 task 对账到相应终态，且绝不自动重发。

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

- 同时只允许一个原生事务；TypeScript 根操作由先进先出执行队列串行，超时且尚未开始的等待者会
  被取消并永不迟到执行。读事务使用 `BEGIN DEFERRED + query_only ON`，写事务使用 `BEGIN IMMEDIATE`。
- 空闲 2 分钟或总寿命 15 分钟自动回滚。
- commit 状态不确定、rollback 失败或 PRAGMA 恢复失败时关闭整个 session。
- 写入或提交后无法确认时返回“结果待核对”语义并使会话失效；普通界面不显示 SQL、路径或内部码。
- WebView 重载会接管现有会话、回滚孤儿事务并清除旧 `restore_source` 附件；无法安全清理时使连接
  失效并重新打开。只有同一同步调用栈中的真正嵌套事务会被拒绝，无关异步根操作不会误报嵌套。

### 5.4 备份与恢复

- WebView 只获得短期票据，不获得真实路径。
- 备份目标必须不存在；恢复源必须是普通文件；票据 TTL 5 分钟。
- 使用 `VACUUM INTO` 创建一致备份。
- 恢复前检查 integrity、foreign key 和主库/备份 schema 完全一致。
- 当前作者数据口径为 173 张应用表：恢复契约复制其中 172 张可恢复表，1 张
  `project_remote_dispatch_leases` 临时远程派发租约表明确不恢复；4 个可重建派生根表会清空后重建。
- 写作体验偏好、Provider 披露 grant、调查 run/step/finding/evidence 六张新增权威表都进入恢复
  顺序；`consistency_investigation_steps.planned_invocation_id` 随整表复制，恢复后仍受 `0069`
  的唯一索引和绑定 trigger 约束。凭据值仍不进入备份。
- 一致性备份可能物理包含不含用户内容的 `project_remote_dispatch_leases` 临时表，但恢复事务明确不复制该表，不能把备份中的旧租约恢复为当前网络事实。
- 新增权威表时必须同步维护恢复表清单、删除顺序、插入顺序和测试。

### 5.5 自动备份

- 自动备份根固定在 Tauri 应用数据目录的 `automatic-backups/v1`，首次使用写入产品所有权标记；页面不能指定其他根目录。
- TypeScript 运行时按本地 03:00 槽位调度，启动时补最近一次漏跑，存活期间每小时检查，默认保留 30 天。
- 原生层使用带过期时间的租约和修订号清单。清单第 2 版区分 `reserved`、`writing`、
  `verifying`、`not_started`、`succeeded`、`failed` 和 `unknown`；旧第 1 版 `creating` 因无法证明写入阶段，
  重启后保守归为 `unknown`，不会盲目覆盖重试。
- `native_automatic_backup_create_verified` 使用独立 SQLite 连接执行 `VACUUM INTO`，核验临时文件的
  integrity、foreign key、schema、大小和 SHA-256 后再以不覆盖语义安装。正文编辑器不等待该连接，
  最终结果无法确认时保留文件并标记底层 `unknown`，普通界面显示“结果待核对”。
- 自动备份创建/检查/删除以及安全更新暂存命令的异步边界使用装箱状态，避免 Tauri 主线程为大型命令
  状态分配接近 1 MiB 的栈空间；该修复不改变锁、超时、取消、重试或结果分类语义。
- 自动备份文件检查回执显式按驼峰字段序列化，与 TypeScript 原生端口一致。实际字段为 `exists`、
  `fileName`、`absolutePath`、`canonicalAbsolutePath`、`byteLength`、`sha256` 和
  `integrityVerified`。此前蛇形字段虽然已经完成文件写入和核验，前端却无法按合同读取，只能保守记为
  `unknown`；`backupId` 属于请求与清单，不属于该检查回执。
- 每次启动检查都会重新核验清单第 2 版的 `succeeded` 文件，从第 1 版 `ready` 记录转入的
  旧成功项也走同一路径。文件缺失、字节数或 SHA-256 不符、文件检查异常时，该项降级为
  底层 `unknown`（普通界面“结果待核对”），最近成功时段回退到较旧的已核验健康备份；系统不会对该时段盲目重发。
- 只有新备份确认成功后才执行保留期清理，上一份健康备份和最新健康备份都不会被失败创建删除。
- 清理不枚举任意目录。只有直系路径、严格文件名、根标记、租约、清单状态、到期时间、文件身份、SQLite 完整性、大小与 SHA-256 全部匹配时才允许删除。
- 手动备份不进入自动备份清单；浏览器开发模式没有原生备份能力，会明确返回不可用而不是伪造文件。
- 隔离 Windows Tauri 首启先以空作品库生成 3,608,576 字节的成功备份，清单与文件 SHA-256 一致；
  独立恢复后 172 张可恢复表一致，作为文件级创建与恢复的首次通过。随后通过正式界面接受 1 份就绪
  AI 建议草稿，源库包含 4 个作品、6 章、7 个不可变版本、1 份 AI 建议草稿、1 个后台任务、
  4 条模型调用记录、2 个开书旅程和 9 轮问答，模型调用增量为 0。今日清单修订 5 生成
  3,653,632 字节备份，SHA-256 为
  `c98594980d258d0d11469a2d102f2f42575d073d854d3209719ee5aa02b96f04`。
- 首次把备份与仍运行的源库比较时，设置页在备份完成后初始化 1 行可重建的
  `story_memory_policies`，比较按合同失败；冻结备份时点源库后复跑，全新恢复目录的 172 张表
  逐表差异 0，源/恢复完整性正常、外键违规均为 0，上述八类作者数据非空且一致。失败证据与最终合同
  分别位于 `.tmp/v026-tauri-regression/evidence/backup-restores/d4-nonempty-due-restore/verification.json`
  和 `.tmp/v026-tauri-regression/evidence/backup-comparisons/d4-nonempty-final-contract.json`。
- 今日成功备份没有删除两份昨日健康文件；3,637,248 字节 / `0a2d8a…c6ef` 与
  3,682,304 字节 / `298b85…de5` 均保持不变。
- 旧第 1 版 `creating` 且目标缺失的条目在真机恢复为底层 `unknown`（普通界面“结果待核对”），较旧健康文件仍保留；权限拒绝、
  磁盘写失败、目标竞争和写入中强制结束目前只有自动化证据，最终安装包真机仍待覆盖。

## 6. 74 个原生 migration

原生版本号把 71 个 `data` migration 与 3 个 `story-core` migration 合并为一个连续序列，因此不等于单个目录中的文件名前缀。

| 原生版本 | SQL 来源                                                                             | 内容                                                              |
| -------: | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
|        1 | `packages/data/migrations/0001_core.sql`                                             | 项目、章节、版本、草稿、AI 候选和审计。                           |
|        2 | `packages/data/migrations/0002_tasks_notifications.sql`                              | 后台任务和通知。                                                  |
|        3 | `packages/story-core/migrations/0001_story_core.sql`                                 | 大纲、正式记录、时间线、评审、记忆和 What-if。                    |
|        4 | `packages/data/migrations/0003_sync_access.sql`                                      | 密文同步、访问快照和授权缓存。                                    |
|        5 | `packages/data/migrations/0004_model_profiles.sql`                                   | 非秘密模型配置。                                                  |
|        6 | `packages/story-core/migrations/0002_materials.sql`                                  | 素材和引用。                                                      |
|        7 | `packages/data/migrations/0005_ai_generation_governance.sql`                         | 定价、预算和生成记录。                                            |
|        8 | `packages/data/migrations/0006_search_index.sql`                                     | FTS 搜索投影。                                                    |
|        9 | `packages/data/migrations/0007_model_routing_usage.sql`                              | 路由、尝试用量和延期生成。                                        |
|       10 | `packages/data/migrations/0008_project_key_lifecycle.sql`                            | 设备公钥、项目密钥版本和信封。                                    |
|       11 | `packages/data/migrations/0009_device_identity_names.sql`                            | 本地设备显示名。                                                  |
|       12 | `packages/data/migrations/0010_sync_inbox.sql`                                       | 收件箱、远程 checkpoint 和设备序列。                              |
|       13 | `packages/data/migrations/0011_cloud_project_key_checkpoints.sql`                    | 云项目密钥 checkpoint。                                           |
|       14 | `packages/data/migrations/0012_cloud_project_key_publications.sql`                   | 崩溃安全发布状态。                                                |
|       15 | `packages/data/migrations/0013_sync_snapshot_staging.sql`                            | 原子快照暂存。                                                    |
|       16 | `packages/data/migrations/0014_sync_protocol_v2_object_types.sql`                    | 同步协议 v2 和对象类型。                                          |
|       17 | `packages/data/migrations/0015_sync_materialization_authority.sql`                   | 注册、明文物化、冲突和投影任务。                                  |
|       18 | `packages/data/migrations/0016_sync_snapshot_materialization_receipts.sql`           | 快照物化回执。                                                    |
|       19 | `packages/data/migrations/0017_sync_projection_account_authority.sql`                | 投影任务绑定账户权威。                                            |
|       20 | `packages/data/migrations/0018_sync_incremental_terminal_observations.sql`           | 增量拉取终态观察。                                                |
|       21 | `packages/data/migrations/0019_cloud_deletion_journal.sql`                           | 云删除恢复日志。                                                  |
|       22 | `packages/data/migrations/0020_graph_rag_projection.sql`                             | 可重建 Graph RAG 投影。                                           |
|       23 | `packages/story-core/migrations/0003_ideation.sql`                                   | 构思草稿。                                                        |
|       24 | `packages/data/migrations/0021_search_vector_index.sql`                              | 本地精确向量索引。                                                |
|       25 | `packages/data/migrations/0022_team_project_key_receipts.sql`                        | 团队项目密钥回执元数据。                                          |
|       26 | `packages/data/migrations/0023_authoritative_story_graph_epoch.sql`                  | 权威故事图 epoch。                                                |
|       27 | `packages/data/migrations/0024_multi_agent_review.sql`                               | 多智能体评审。                                                    |
|       28 | `packages/data/migrations/0025_governed_creative_extensions.sql`                     | 翻译、短剧、预算、同意和候选。                                    |
|       29 | `packages/data/migrations/0026_team_template_applications.sql`                       | 团队模板本地应用回执。                                            |
|       30 | `packages/data/migrations/0027_authoritative_extraction.sql`                         | 权威抽取任务、评估和决定。                                        |
|       31 | `packages/data/migrations/0028_fine_tuning_governance.sql`                           | 微调数据、审批、任务、评估、部署和审计。                          |
|       32 | `packages/data/migrations/0029_community_marketplace_installs.sql`                   | 社区市场安装记录。                                                |
|       33 | `packages/data/migrations/0030_creative_journeys.sql`                                | 可恢复的一句话开书与导入创作旅程。                                |
|       34 | `packages/data/migrations/0031_model_hub.sql`                                        | Model Hub 连接、目录、能力、路由、策略和调用事实。                |
|       35 | `packages/data/migrations/0032_unified_story_facts.sql`                              | 统一、证据化 StoryFact 与修订/旧数据链接。                        |
|       36 | `packages/data/migrations/0033_causal_event_graph.sql`                               | 可重建的因果事件图投影。                                          |
|       37 | `packages/data/migrations/0034_context_compilation_trace.sql`                        | 不含正文的上下文编译历史。                                        |
|       38 | `packages/data/migrations/0035_writing_feedback_learning.sql`                        | 用户可见、可控的写作反馈学习。                                    |
|       39 | `packages/data/migrations/0036_story_planning_candidates.sql`                        | 只供审阅的 AI 剧情规划候选。                                      |
|       40 | `packages/data/migrations/0037_model_hub_expert_options.sql`                         | 不含秘密的 Model Hub 专家连接元数据。                             |
|       41 | `packages/data/migrations/0038_private_chapters.sql`                                 | 章节级仅本机隐私门禁与导出默认排除。                              |
|       42 | `packages/data/migrations/0039_project_seeds.sql`                                    | 三条创建旅程共享、可修订的项目创作种子。                          |
|       43 | `packages/data/migrations/0040_chapter_validation_snapshots.sql`                     | 绑定不可变章节版本的确定性检查快照。                              |
|       44 | `packages/data/migrations/0041_story_planning_selective_acceptance.sql`              | 规划候选目标基线与逐项采纳回执。                                  |
|       45 | `packages/data/migrations/0042_chapter_validation_snapshot_delete_cascade.sql`       | 修复检查快照在章节/项目删除与恢复时的级联语义。                   |
|       46 | `packages/data/migrations/0043_story_fact_entity_alias_resolution.sql`               | 只允许受审计、带修订的实体别名人工消歧。                          |
|       47 | `packages/data/migrations/0044_story_planning_selective_acceptance_intent.sql`       | 正式大纲变更前持久预留逐项采纳意图。                              |
|       48 | `packages/data/migrations/0045_project_remote_dispatch_leases.sql`                   | 项目上下文远程派发的内容无关租约、隐私变更与删除防护。            |
|       49 | `packages/data/migrations/0046_model_hub_zhipu_glm.sql`                              | 前向重建 Provider 连接约束，允许独立 GLM 连接类型。               |
|       50 | `packages/data/migrations/0047_context_compilation_exact_provenance.sql`             | 上下文编译到 generation、调用事实和最终 Candidate 的不可变关联。  |
|       51 | `packages/data/migrations/0048_candidate_application_intents.sql`                    | Candidate 任务语义、载荷形状、应用方式与 UTF-16 锚点。            |
|       52 | `packages/data/migrations/0049_memory_governance_audit.sql`                          | 项目记忆忘却和人工合并的不可变治理审计。                          |
|       53 | `packages/data/migrations/0050_candidate_revision_authority.sql`                     | Candidate 单调修订、CAS 决定和内容校验权威。                      |
|       54 | `packages/data/migrations/0051_model_hub_connection_commits.sql`                     | 不含密钥的 Model Hub 跨存储提交与补偿 journal。                   |
|       55 | `packages/data/migrations/0052_continuous_story_state_route_receipts.sql`            | 连续故事状态提取的版本/路由完成收据。                             |
|       56 | `packages/data/migrations/0053_writing_feedback_learning_policy_context.sql`         | 反馈发生时学习策略与自定义意见哈希簇。                            |
|       57 | `packages/data/migrations/0054_writing_feedback_explicit_idempotency.sql`            | 明确反馈幂等身份与反馈/偏好原子同步边界。                         |
|       58 | `packages/data/migrations/0055_continuous_story_state_historical_route_receipts.sql` | 合法历史状态回执的备份恢复约束。                                  |
|       59 | `packages/data/migrations/0056_model_hub_failure_diagnostics.sql`                    | 能力扫描与调用事实的可空、脱敏 AI 失败诊断字段和索引。            |
|       60 | `packages/data/migrations/0057_model_hub_content_quality_task.sql`                   | 为三张 Model Hub 表前向补齐内容质量检查任务合同。                 |
|       61 | `packages/data/migrations/0058_story_settings_import_receipts.sql`                   | 原子故事设定导入、冲突处理和可验证撤销所需的收据。                |
|       62 | `packages/data/migrations/0059_generation_preflight_cost_status.sql`                 | 区分可估费用与价格未知，后者只提示而不阻断基础写作。              |
|       63 | `packages/data/migrations/0060_novel_skill_registry.sql`                             | 默认关闭的 Novel Skill definition、项目 binding 和调用 snapshot。 |
|       64 | `packages/data/migrations/0061_novel_skill_evaluation_ledger.sql`                    | 不含题目和输出内容的付费评测账本、证据与人工决定链。              |
|       65 | `packages/data/migrations/0062_project_dispatch_active_guard.sql`                    | 已有项目派发租约存续时禁止项目离开 active。                       |
|       66 | `packages/data/migrations/0063_novel_skill_evaluation_paid_runner.sql`               | 精确付费目标、商业授权、费用上限、reservation 与盲评。            |
|       67 | `packages/data/migrations/0064_novel_skill_evaluation_predispatch_authority.sql`     | 内容无关的 payload 子哈希、能力/目标锁和派发前估价权威。          |
|       68 | `packages/data/migrations/0065_model_invocation_dispatch_boundary.sql`               | 在现有调用事实上持久不含内容的 Provider 发送边界。                |
|       69 | `packages/data/migrations/0066_writing_experience_preferences.sql`                   | 写作模式、本地整理授权和内容无关的 Provider 披露 grant。          |
|       70 | `packages/data/migrations/0067_consistency_investigation_agent.sql`                  | 有界调查 run、step、finding 和 evidence。                         |
|       71 | `packages/data/migrations/0068_writing_disclosure_active_grant_limit.sql`            | 披露 grant 上限只统计 active 行，保留 terminal 审计。             |
|       72 | `packages/data/migrations/0069_consistency_investigation_invocation_reservation.sql` | 调查模型 step 的 content-free invocation 预留与原子绑定。         |
|       73 | `packages/data/migrations/0070_multigranular_search_retrieval.sql`                   | 可重建搜索投影的多粒度范围、锚点、权威性、隐私与 currentness。    |
|       74 | `packages/data/migrations/0071_model_capability_probe_invocation_ledger.sql`         | 固定能力验证的独立调用任务、能力证据外键和不可改绑约束。          |
|       75 | `packages/data/migrations/0072_ai_candidate_purpose.sql`                             | 隔离结果用途、历史安全默认值和方向不得接受为正文的约束。          |
|       76 | `packages/data/migrations/0073_story_fact_user_revisions.sql`                        | 用户故事事实内容修订、治理转换与身份证据不可变约束。              |
|       77 | `packages/data/migrations/0074_chapter_version_story_fact_responsibility.sql`        | 不可变版本的本地故事资料整理责任与不可修改约束。                  |
|       78 | `packages/data/migrations/0075_generation_attempt_privacy_snapshot.sql`              | 生成尝试隐私快照、同一调用标识与新行完整性约束。                  |
|       79 | `packages/data/migrations/0076_direct_local_story_fact_author_revision.sql`          | 直接模式本地故事资料的作者修订与审计，不改变权威正文和版本。      |
|       80 | `packages/data/migrations/0077_project_display_identities.sql`                       | 内容无关的项目显示身份、修订历史和保护约束。                      |
|       81 | `packages/data/migrations/0078_generation_attempt_prose_invocation.sql`              | 扩展隐私守卫，使续写与开头生成绑定精确模型调用标识。              |
|       82 | `packages/data/migrations/0079_story_fact_evidence.sql`                              | 为受治理故事资料追加多处不可变正文依据。                          |
|       83 | `packages/data/migrations/0080_candidate_selection_action.sql`                       | 为新选区隔离结果冻结改写、润色、扩写或缩写的准确动作。            |
|       84 | `packages/data/migrations/0081_story_fact_evidence_guard_performance.sql`            | 保持精确 UTF-16 证据守卫并消除长正文重复字节扫描。                |
|       85 | `packages/data/migrations/0082_author_recovery_records.sql`                          | 保存项目级、带版本与修订的作者恢复记录，并进入备份恢复合同。      |

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
- 所有固定能力验证都使用独立 `capability_probe` 调用任务。网络开始前，原生网关必须在同一
  SQLite 权威库中原子核对调用标识、任务、连接、模型、范围和修订并写入发送时间；核对失败时
  不启动网络。成功或失败的能力证据只能绑定这条精确终态调用记录，取消和发送前失败不制造
  真实调用，发送后结果无法确认则结清为“结果待核对”且不自动重发。
- Ollama：`/api/tags`、`/api/chat` NDJSON、`/api/embed`。
- Anthropic：官方模型目录和 Messages SSE 文本生成。
- Gemini：官方模型目录、流式文本生成和批量 Embedding。
- 阿里云百炼/Qwen Rerank：底层只实现北京地域、Workspace 绑定的已验证 OpenAI-compatible
  `/reranks` 协议；当前没有 production caller，普通搜索仍使用本地 FTS，不会触发该远程路径。
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

若未来接入 production caller，Qwen 远程重排还必须经过 Model Hub 的用户远程内容同意、ready
连接、OS 凭据、能力、隐私、费用和配置指纹门禁；任何失败都必须保留本地确定性排序。当前只有
Rust 协议测试和本地模拟服务，没有可达 production caller，也没有真实 Qwen Key 的线上端到端证据。

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
12. 导出保存的票据、写入与回读已有自动化；真实 Windows Tauri 保存对话框和四种外部应用打开仍为 `BLOCKED_EXTERNAL`。
