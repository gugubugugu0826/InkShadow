# InkShadow 共享核心包逐文件指引

> 基于源码快照：2026-09-02  
> 文档状态：`SUPPORTING_CURRENT`  
> 当前交付目标：`0.2.17` 人工复测候选；只保留本地人工复测附件，不授权标签或 GitHub Release；设计基线：`DESIGN v0.3.1b`  
> 覆盖范围：`packages/*/src` 的 17 个工作区包，以及 `packages/data/migrations` 的 82 个本地数据库迁移（当前源码前向上限为 `0082`）

## 0. 0.2.17 人工复测候选当前事实

- `ai-core` 以一套共享策略明确正文任务的指令优先级、篇幅轮廓、自然停止条件和可见输出边界。安全与隐私、已保存正文和锁定事实不能被任务要求、规划、技能、偏好或通用风格覆盖；正文结果不得夹带分析、解释、代码围栏、内部标签或结尾元说明，结构化任务继续使用独立契约。
- 资料编译会先为必需规则与最新正文保留预算，再纳入可选来源；跨适配器重复内容按来源、版本、定位和内容指纹精确合并。采用与省略都保留来源、版本、原因和预算记录，低相关旧摘要或通用资料不能挤掉当前任务、最新正文或直接相关的锁定设定。
- 写作技能继续使用不可变定义、版本和项目绑定，但“已启用”不等于“已采用”。只有与本次任务匹配、实际进入编译、完成发送前快照并写入调用关系的技能才属于本次采用；未采用项保留自然中文原因，不得偷偷进入提示词。
- `story-core` 的本地事实整理只从明确语义和不可变版本范围形成待确认记录；亲属词本身不再被当作关系声明。摘要是否最新由摘要来源版本与当前正文版本决定；一致性结果明确区分已检查未发现、证据不足、本次未执行和检查失败。
- 远程正文、规划、摘要、审稿、一致性、向量、后台整理和自动任务在项目或章节要求本地处理时，都必须在网关调用前失败关闭。远程派发租约只承载无用户内容的并发与隐私修订事实，不能成为绕过隐私权威、自动续租发送或自动重试的第二入口；本地确定性整理不受影响。
- 当前源码仍沿用 Data `0082_author_recovery_records.sql`／Tauri `85`，0.2.17 没有新增迁移、没有修改已发布迁移或校验值，也没有为编辑器草稿、提示词或私密派发增加平行数据库事实源。
- 当前结论来自源码与自动化，不构成真实供应商、真实安装程序或现场数据验证。0.2.17 只生成安装包、来源清单、SHA-256、验证报告和人工复测说明五项本地附件；真实安装人工复测前不创建标签、GitHub Release 或公开附件。

## 0.1 0.2.16 历史事实

- `0080_candidate_selection_action.sql` 的已发布合同保持不变：新选区隔离结果必须保存改写、润色、扩写或缩写的准确动作。桌面生产提交单元现在完整查询、写入并做幂等比较，不通过放宽触发器或填入无意义占位解决 F17。
- 隔离结果提交失败不会改变正文、不可变版本或历史候选；已收到但未安全保存的片段只能由作者复制或明确放弃。发送事实继续使用同一调用链，自动重试为零。
- 章节隐私沿用领域实体和应用用例的预期修订合同；示例／测试身份沿用项目显示身份；通知标记与清除按批次处理全部记录，清除只隐藏已读通知并保留任务与审计。0.2.16 不增加平行存储。
- 自定义技能仍使用不可变定义、版本和项目绑定；自然语言整理只从明确适用任务段落生成任务范围，最终是否采用仍由编译、预算、冲突和发送前快照共同决定。
- 0.2.16 源码沿用 Data `0082_author_recovery_records.sql`／Tauri `85`，该版本没有新增迁移。v0.2.15 及更早迁移、标签、Release 和附件保持不可变。
- 该节结论来自 0.2.16 当时的源码和自动化；真实供应商调用、真实安装程序和现场数据库均未执行或未取得。

## 0.2 0.2.15 历史事实

- 开书编排沿用 ProjectSeed、可恢复创作旅程、稳定方案槽位、Model Hub 调用事实和隔离建议的单一状态链。共享领域与应用包只承认明确终态；发送前失败为零发送，发送后结果不确定时不自动重试，模型输出不能绕过建议隔离直接写入正文。
- 写作技能由 `ai-core` 的严格定义和编译合同、Desktop 的项目绑定与准备流程、发送前采用快照以及最终建议来源共同串联。技能默认关闭，只采用作者明确启用且能放入有界调用条目的版本；方法与作品规则冲突时以作者要求和已确认故事规则为准，派生采用失败不改变正文。
- F10 的能力分类来自供应商目录、任务要求或仍有效的能力证据；只有唯一可信结论才可推荐文字或语义向量检查，结论不明确时必须由作者选择并保持零发送。向量能力证据只能来自通过数量、维度、有限数值和非零检查的真实向量响应，不能由模型名称或文字输出推断。
- U8 保存失败活动连接时复用 `ModelProviderConnection` 的凭据引用和状态，不读取凭据原文；每次保存、连接测试和目录更新均使用期望修订，陈旧写入失败而不覆盖新设置。重试失败保留活动连接和历史调用，退役只由独立明确操作执行。
- 导出包负责生成有界的 TXT、Markdown、项目包、EPUB、DOCX、PDF 和报告字节；它不持有任意文件系统权限。目标选择、写入、原子替换、最终哈希复核与打开文件均由 Tauri 原生命令执行，浏览器开发模式不会伪造真实落盘。
- 当前源码沿用已提交的 Data `0082_author_recovery_records.sql`／Tauri `85`，为项目级、带修订的作者恢复记录提供备份恢复存储；本轮后续工作树没有再新增迁移。v0.2.14 及更早迁移字节、校验和、标签、Release 与附件保持不变。
- 当前结论来自源码和自动化；真实供应商调用与 0.2.15 真实安装程序人工验证尚未执行。

`0071` 已随 `v0.2.6` 工程预发布冻结；`0072`–`0075` 已随 `v0.2.7` 最终候选冻结：
`0074` 冻结不可变章节版本的本地故事资料整理责任，`0075` 保存生成尝试隐私快照及同一次调用标识。
`0076`–`0077` / Tauri `79`–`80` 已随 `v0.2.9` 来源提交 `54d9647031bb97b4fc9f021d3b1acca7f6d25c47` 冻结；0.2.10 与 0.2.11 均没有新增迁移。
`0078_generation_attempt_prose_invocation.sql` / Tauri `81` 已随 v0.2.12 冻结。0.2.14 当前只向前新增 `0079_story_fact_evidence.sql`／Tauri `82`、`0080_candidate_selection_action.sql`／Tauri `83` 和 `0081_story_fact_evidence_guard_performance.sql`／Tauri `84`。`0079` 以追加关系保存同一事实的多处不可变依据，历史重复行不删除、不改写；`0080` 为新选区隔离结果冻结准确动作；`0081` 保持精确 UTF-16 总长、边界与摘录核对，并消除长正文递归扫描的重复字节读取。聚焦迁移、维护和备份恢复自动化已经通过；最终同源候选和人工安装门禁尚未完成。
既有版本的最终候选、远端门禁、未签名打包和公开预发行事实保持不变；真实供应商和最终安装程序真机仍未完成，且不能借此改写
`v0.2.9`、`v0.2.7`、`v0.2.6` 及更早标签、迁移校验值和制品证据。

这些包不是“页面”，也不应全部叫作后端。它们承载可被 Desktop、Cloud API、Web 或测试复用的领域规则、用例、契约、数据适配器和 UI 基础件。正常依赖方向是“领域与协议 → 应用用例 → 基础设施适配器 → 应用入口”；`scripts/check-boundaries.mjs` 会检查主要边界。

| Package         | 源文件数 | 定位                                                |
| --------------- | -------: | --------------------------------------------------- |
| `access-core`   |        7 | 身份、权益、许可和 RBAC 规则                        |
| `ai-core`       |       29 | 模型协议、路由、上下文、重排、预算和 AI 治理        |
| `application`   |       14 | 应用用例与持久化端口                                |
| `cloud-client`  |        7 | Cloud API 客户端                                    |
| `config`        |        4 | 环境、功能开关和设置                                |
| `contracts`     |       14 | 跨进程/网络契约和 OpenAPI                           |
| `data`          |       25 | Desktop SQLite 适配                                 |
| `domain`        |       13 | 核心写作实体和值对象                                |
| `import-export` |       20 | 导入、导出和便携包                                  |
| `observability` |        5 | 本地结构化日志和脱敏诊断                            |
| `platform`      |        4 | 时钟、哈希和 UUID 平台实现                          |
| `search-core`   |        6 | 内存搜索、混合评分和 Graph RAG 规则                 |
| `story-core`    |       45 | StoryFact、因果、验证、声纹、叙事、创作工作流和仓储 |
| `sync-core`     |        9 | 加密同步协议                                        |
| `task-engine`   |       10 | 耐久任务领域模型和调度                              |
| `test-utils`    |        5 | 仅测试辅助                                          |
| `ui`            |       15 | 共享 React 组件和样式                               |

## 1. `access-core`：身份、授权与许可

| 文件                                          | 内容                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/access-core/src/entitlements.ts`    | Community/Pro/Studio/Enterprise 权益、订阅状态与产品能力判定；本地能力和需服务端证明的远程能力分开处理。 |
| `packages/access-core/src/errors.ts`          | 访问核心的稳定错误码与 `AccessCoreError`。                                                               |
| `packages/access-core/src/identity.ts`        | 云账户、注册设备、云会话、版本约束及登录失败节流领域规则。                                               |
| `packages/access-core/src/index.ts`           | 包的公开导出入口。                                                                                       |
| `packages/access-core/src/offline-license.ts` | 离线许可证信封解析、规范化签名载荷和 Web Crypto 验签。                                                   |
| `packages/access-core/src/rbac.ts`            | 团队角色、资源动作、项目业务访问、项目密钥信封资格与成员变更审计计划。                                   |
| `packages/access-core/src/validation.ts`      | 标识符、ISO 时间、唯一排序集合和严格对象字段校验。                                                       |

## 2. `ai-core`：AI 协议、预算与治理

该包定义策略和协议，不包含模型 provider 实现，也不会直接发起网络调用。

| 文件                                                             | 内容                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/ai-core/src/budget.ts`                                 | Token 成本估算、任务/项目/月预算和 warn/hard 预算决策。                            |
| `packages/ai-core/src/candidate.ts`                              | AI 候选状态、应用模式和把候选内容合入正文前的安全计划。                            |
| `packages/ai-core/src/connection-test.ts`                        | 模型连接测试各步骤、脱敏后的端点来源和结果报告。                                   |
| `packages/ai-core/src/context-compiler.ts`                       | 十二层上下文顺序、逐条来源与 Token 追踪、必选预算失败及旧 PromptSection 适配。     |
| `packages/ai-core/src/continuation-recovery.ts`                  | 续写运行在中断、未派发与结果不明确状态间的保守恢复规则。                           |
| `packages/ai-core/src/evidence-rerank.ts`                        | 本机确定性证据重排、评分拆分、选择理由和稳定回退顺序。                             |
| `packages/ai-core/src/generation-state.ts`                       | 生成任务状态机、允许的状态转换与终态判定。                                         |
| `packages/ai-core/src/governed-creative-extensions.ts`           | 翻译、短剧等受治理创意扩展的严格 JSON 协议、大小上限和解析/序列化。                |
| `packages/ai-core/src/index.ts`                                  | 包的公开导出入口。                                                                 |
| `packages/ai-core/src/long-form-retrieval-benchmark-fixtures.ts` | 固定、可复现的长篇检索评测夹具，不包含真实作品内容。                               |
| `packages/ai-core/src/long-form-retrieval-benchmark.ts`          | Production 长篇检索 benchmark 编排、分层指标与安全阈值；v0.2.5 冻结实跑 2/2 PASS。 |
| `packages/ai-core/src/model.ts`                                  | 模型配置、生成/嵌入/计数请求、流事件、适配器与原生模型网关契约。                   |
| `packages/ai-core/src/multi-agent-protocol.ts`                   | 多智能体评审结论、来源引用、任务建议和候选补丁的严格公开协议。                     |
| `packages/ai-core/src/novel-skill*.ts`                           | Novel Skill 定义、内建模板、编译、类型、激活与评测合同；默认关闭并由作者启用。     |
| `packages/ai-core/src/preflight.ts`                              | 生成前对模型可用性、上下文、定价、预算和数据边界的检查。                           |
| `packages/ai-core/src/prompt-registry.ts`                        | Prompt 版本、变量、激活计划、规范化校验与安全渲染。                                |
| `packages/ai-core/src/quality-gate.ts`                           | 候选质量指标、证据、阈值和重复度等质量门禁。                                       |
| `packages/ai-core/src/retrieval-evaluation.ts`                   | Recall@K、MRR、nDCG、权威精度、污染与隐私泄漏等确定性检索指标。                    |
| `packages/ai-core/src/routing.ts`                                | 按模型角色、位置和验证状态解析实际模型路由。                                       |
| `packages/ai-core/src/story-memory-read-model.ts`                | 从已接受正文与确认事实构建只读 StoryMemory 视图并隔离非 canon 内容。               |
| `packages/ai-core/src/task-output-profile.ts`                    | 任务类型对应的结构化输出、预算和能力要求。                                         |

## 3. `application`：应用用例与端口

这个包编排领域对象，但不直接依赖 React、Tauri、SQLite 或 HTTP。

| 文件                                                                         | 内容                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/application/src/index.ts`                                          | 应用层公开导出入口。                                                               |
| `packages/application/src/ports/chapter-repositories.ts`                     | 章节、版本、恢复草稿、AI 候选和原子内容提交仓储端口。                              |
| `packages/application/src/ports/content-hasher.ts`                           | 正文内容哈希端口。                                                                 |
| `packages/application/src/ports/graph-rag-repository.ts`                     | Graph RAG 投影、来源版本、实体关系和权威变更仓储端口。                             |
| `packages/application/src/ports/project-import-repository.ts`                | 项目导入事务所需的持久化端口。                                                     |
| `packages/application/src/ports/project-repository.ts`                       | 项目仓储端口。                                                                     |
| `packages/application/src/use-cases/authoritative-story-graph-projection.ts` | 从权威故事记录规划并提交 Graph RAG 投影。                                          |
| `packages/application/src/use-cases/candidate-merge-planner.ts`              | 计算 AI 候选进入章节时的合并、冲突和基线校验计划。                                 |
| `packages/application/src/use-cases/candidate-use-cases.ts`                  | 创建、读取、编辑、接受和拒绝 AI 候选；接受按不可变任务意图应用续写/选区/整章载荷。 |
| `packages/application/src/use-cases/chapter-use-cases.ts`                    | 章节创建、保存、版本恢复与恢复草稿用例。                                           |
| `packages/application/src/use-cases/graph-rag-use-cases.ts`                  | Graph RAG 来源写入、失效、读取和投影状态用例。                                     |
| `packages/application/src/use-cases/project-import-use-case.ts`              | 校验导入计划并以事务方式写入项目。                                                 |
| `packages/application/src/use-cases/project-use-cases.ts`                    | 项目创建、读取、列表、归档和回收站生命周期用例。                                   |
| `packages/application/src/use-cases/shared.ts`                               | 用例共用的输入校验、错误转换和辅助逻辑。                                           |

## 4. `cloud-client`：Cloud API 客户端

| 文件                                              | 内容                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/cloud-client/src/client.ts`             | 身份、设备、项目、同步、删除、Enterprise、评审和用量等 Cloud API 调用入口。 |
| `packages/cloud-client/src/errors.ts`             | HTTP、协议、身份和本地安全边界的稳定客户端错误。                            |
| `packages/cloud-client/src/index.ts`              | 包的公开导出入口。                                                          |
| `packages/cloud-client/src/marketplace-client.ts` | 社区市场浏览、安装、审核、申诉和状态操作客户端。                            |
| `packages/cloud-client/src/request-id.ts`         | 请求 ID 创建和格式校验。                                                    |
| `packages/cloud-client/src/team-client.ts`        | 团队、成员、邀请、角色、项目密钥信封和团队资源客户端。                      |
| `packages/cloud-client/src/transport.ts`          | Fetch transport、超时、认证头、响应解码和原生密码边界拒绝规则。             |

这是客户端库，不是服务端。它从调用方提供的 token provider 取凭据而不持久化 token；Desktop
实际可用范围还受原生 relay allowlist 和 Feature Flag 限制。

注意：四个需要密码确认的删除操作被标为 native password boundary，普通 Fetch transport 会主动拒绝；Desktop 必须通过受信任的原生边界完成，而不是把密码交给浏览器 JavaScript。

## 5. `config`：环境与功能开关

| 文件                                   | 内容                                             |
| -------------------------------------- | ------------------------------------------------ |
| `packages/config/src/environment.ts`   | 运行环境、布尔值、URL 和数值环境变量的严格解析。 |
| `packages/config/src/feature-flags.ts` | 功能标志定义、默认值、依赖关系和失败关闭行为。   |
| `packages/config/src/index.ts`         | 包的公开导出入口。                               |
| `packages/config/src/settings.ts`      | 应用设置模型、默认值和输入规范化。               |

## 6. `contracts`：跨边界协议

这是 Cloud API 和客户端共同使用的请求/响应真相源。接口逐项说明见 [`../front-end/INTERFACE_REFERENCE.md`](../front-end/INTERFACE_REFERENCE.md)。

| 文件                                                  | 内容                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/cloud-api-schemas.ts`         | 云身份、设备、项目、同步、快照、删除等 API 的 Zod 请求/响应 schema。                                                    |
| `packages/contracts/src/cloud-canonical-json.ts`      | 云协议签名或哈希所需的规范 JSON 编码。                                                                                  |
| `packages/contracts/src/cloud-openapi.ts`             | 81 个 `/v1` 操作的运行时注册表、方法、路径、权限和 Zod 校验入口。                                                       |
| `packages/contracts/src/openapi.ts`                   | 仅供测试和文档工具使用的 OpenAPI 3.1 文档生成器；通过 `@inkshadow/contracts/openapi` 显式导入，不进入桌面运行时主入口。 |
| `packages/contracts/src/cloud-schemas.ts`             | 云领域共用 ID、游标、加密块、操作和分页 schema。                                                                        |
| `packages/contracts/src/enterprise-api-schemas.ts`    | Enterprise SSO、策略和管理接口 schema。                                                                                 |
| `packages/contracts/src/index.ts`                     | 包的公开导出入口。                                                                                                      |
| `packages/contracts/src/marketplace-api-schemas.ts`   | 社区市场列表、版本、安装、审核、申诉和处置 schema。                                                                     |
| `packages/contracts/src/review-api-schemas.ts`        | 加密评审线程、评论和状态 schema。                                                                                       |
| `packages/contracts/src/schemas.ts`                   | 本地项目、章节、任务、通知等共享 schema。                                                                               |
| `packages/contracts/src/states.ts`                    | 跨应用使用的稳定状态枚举和转换约定。                                                                                    |
| `packages/contracts/src/team-api-schemas.ts`          | 团队、成员、邀请、RBAC 和项目密钥信封 schema。                                                                          |
| `packages/contracts/src/team-template-api-schemas.ts` | 加密团队模板发布、版本和读取 schema。                                                                                   |
| `packages/contracts/src/usage-api-schemas.ts`         | AI 用量预算、预留、结算和查询 schema。                                                                                  |

## 7. `data`：Desktop SQLite 适配层

| 文件                                                              | 内容                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/data/src/access-sqlite-store.ts`                        | 本地账户、权益、设备、会话和访问状态 SQLite 存储。                                                                                                                                                |
| `packages/data/src/cloud-deletion-journal-sqlite-store.ts`        | 云删除请求的本地耐久日志和重试状态。                                                                                                                                                              |
| `packages/data/src/executor.ts`                                   | 参数化 SQL 执行器、事务和结果类型端口。                                                                                                                                                           |
| `packages/data/src/fine-tuning-governance-sqlite-store.ts`        | 为 Story Core 微调仓储提供 `SqlExecutor` 适配外壳；真正的领域校验和编排位于 `story-core`。                                                                                                        |
| `packages/data/src/governed-creative-extension-sqlite-store.ts`   | 翻译/短剧等受治理候选和应用记录存储。                                                                                                                                                             |
| `packages/data/src/governed-extension-provider-url.ts`            | 对 provider URL 做确定性分类和比较；它明确不是完整 SSRF 防护，最终 DNS/IP/连接限制由 Rust 原生网关执行。                                                                                          |
| `packages/data/src/graph-rag-sqlite-store.ts`                     | Graph RAG 来源、节点、边、投影 epoch 和权威状态存储。                                                                                                                                             |
| `packages/data/src/index.ts`                                      | 包的公开导出入口。                                                                                                                                                                                |
| `packages/data/src/maintenance.ts`                                | integrity/FK 检查、`VACUUM INTO` 备份、176 张可恢复表、4 个派生根表清空和 schema 恢复契约；兼容旧 Tauri `73` 能力扫描列以及缺少故事事实证据表或作者恢复记录表的旧备份，临时远程派发租约表不恢复。 |
| `packages/data/src/multi-agent-review-sqlite-store.ts`            | 多智能体评审任务、结论、证据和候选记录存储。                                                                                                                                                      |
| `packages/data/src/project-key-sqlite-store.ts`                   | 项目密钥版本、发布检查点和团队信封回执存储。                                                                                                                                                      |
| `packages/data/src/project-seed-sqlite-store.ts`                  | 新手创建旅程的 ProjectSeed、恢复点和一次性物化回执存储。                                                                                                                                          |
| `packages/data/src/schema.ts`                                     | 核心写作、AI 治理、搜索、Graph RAG、多智能体和创意扩展的 Drizzle 表声明；迁移清单权威在 Rust `local_migrations.rs`。                                                                              |
| `packages/data/src/search-vector-sqlite-store.ts`                 | 搜索向量、嵌入来源和索引元数据存储。                                                                                                                                                              |
| `packages/data/src/sqlite-repositories.ts`                        | 应用层项目、章节、版本、草稿、候选和导入仓储的 SQLite 实现。                                                                                                                                      |
| `packages/data/src/sync-access-schema.ts`                         | 同步身份、访问和本地账户权威表的 schema 辅助定义。                                                                                                                                                |
| `packages/data/src/sync-incremental-settlement-sqlite-store.ts`   | 增量同步 terminal observation 和结算进度存储。                                                                                                                                                    |
| `packages/data/src/sync-materialization-sqlite-store.ts`          | 同步对象落地到本地领域表的幂等物化存储。                                                                                                                                                          |
| `packages/data/src/sync-snapshot-materialization-sqlite-store.ts` | 云快照暂存、验证、提交和物化回执存储。                                                                                                                                                            |
| `packages/data/src/sync-sqlite-store.ts`                          | 同步出站/入站操作、游标、tombstone、chunk 和传输台账存储。                                                                                                                                        |
| `packages/data/src/task-sqlite-repositories.ts`                   | 任务、租约、进度、失败、通知和任务日志仓储实现。                                                                                                                                                  |
| `packages/data/src/tauri-sqlite.ts`                               | 把 Tauri command 封装为参数化 SQLite executor；先进先出串行根操作、有界等待、迟到操作取消，并区分未开始与写入/提交结果待核对。                                                                    |
| `packages/data/src/team-template-application-sqlite-store.ts`     | 团队模板应用计划、执行状态和本地回执存储。                                                                                                                                                        |

### 7.1 本地数据库迁移

迁移只允许向前追加。启动时 Rust 原生层会核对已经执行的版本和校验和；发生不一致时会停止打开数据库，避免静默覆盖用户数据。

| 文件                                                                                 | 内容                                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/data/migrations/0001_core.sql`                                             | 项目、章节、章节版本、恢复草稿和 AI 候选核心表。                                                                                                                               |
| `packages/data/migrations/0002_tasks_notifications.sql`                              | 任务、任务日志和通知。                                                                                                                                                         |
| `packages/data/migrations/0003_sync_access.sql`                                      | 同步操作、块、tombstone、游标及本地访问状态。                                                                                                                                  |
| `packages/data/migrations/0004_model_profiles.sql`                                   | 模型配置档案。                                                                                                                                                                 |
| `packages/data/migrations/0005_ai_generation_governance.sql`                         | AI 生成状态、成本、预算和治理信息。                                                                                                                                            |
| `packages/data/migrations/0006_search_index.sql`                                     | 本地搜索索引基础表。                                                                                                                                                           |
| `packages/data/migrations/0007_model_routing_usage.sql`                              | 模型路由与用量记录。                                                                                                                                                           |
| `packages/data/migrations/0008_project_key_lifecycle.sql`                            | 项目密钥版本和生命周期。                                                                                                                                                       |
| `packages/data/migrations/0009_device_identity_names.sql`                            | 设备身份显示名等扩展字段。                                                                                                                                                     |
| `packages/data/migrations/0010_sync_inbox.sql`                                       | 入站同步暂存队列。                                                                                                                                                             |
| `packages/data/migrations/0011_cloud_project_key_checkpoints.sql`                    | 云项目密钥检查点。                                                                                                                                                             |
| `packages/data/migrations/0012_cloud_project_key_publications.sql`                   | 项目密钥发布记录。                                                                                                                                                             |
| `packages/data/migrations/0013_sync_snapshot_staging.sql`                            | 快照同步暂存。                                                                                                                                                                 |
| `packages/data/migrations/0014_sync_protocol_v2_object_types.sql`                    | 同步协议 v2 对象类型扩展。                                                                                                                                                     |
| `packages/data/migrations/0015_sync_materialization_authority.sql`                   | 同步物化的账户/设备权威信息。                                                                                                                                                  |
| `packages/data/migrations/0016_sync_snapshot_materialization_receipts.sql`           | 快照物化回执。                                                                                                                                                                 |
| `packages/data/migrations/0017_sync_projection_account_authority.sql`                | 同步投影的账户权威约束。                                                                                                                                                       |
| `packages/data/migrations/0018_sync_incremental_terminal_observations.sql`           | 增量同步终态观察和结算。                                                                                                                                                       |
| `packages/data/migrations/0019_cloud_deletion_journal.sql`                           | 云删除本地日志。                                                                                                                                                               |
| `packages/data/migrations/0020_graph_rag_projection.sql`                             | Graph RAG 投影、来源、节点和边。                                                                                                                                               |
| `packages/data/migrations/0021_search_vector_index.sql`                              | 搜索向量索引与嵌入元数据。                                                                                                                                                     |
| `packages/data/migrations/0022_team_project_key_receipts.sql`                        | 团队项目密钥信封回执。                                                                                                                                                         |
| `packages/data/migrations/0023_authoritative_story_graph_epoch.sql`                  | 权威故事图谱 epoch 和失效边界。                                                                                                                                                |
| `packages/data/migrations/0024_multi_agent_review.sql`                               | 多智能体评审记录。                                                                                                                                                             |
| `packages/data/migrations/0025_governed_creative_extensions.sql`                     | 受治理创意扩展记录。                                                                                                                                                           |
| `packages/data/migrations/0026_team_template_applications.sql`                       | 团队模板应用记录。                                                                                                                                                             |
| `packages/data/migrations/0027_authoritative_extraction.sql`                         | 正文权威抽取记录。                                                                                                                                                             |
| `packages/data/migrations/0028_fine_tuning_governance.sql`                           | 微调治理记录。                                                                                                                                                                 |
| `packages/data/migrations/0029_community_marketplace_installs.sql`                   | 社区市场本地安装记录。                                                                                                                                                         |
| `packages/data/migrations/0030_creative_journeys.sql`                                | 可恢复创作旅程和有序轮次。                                                                                                                                                     |
| `packages/data/migrations/0031_model_hub.sql`                                        | Model Hub 连接、目录、能力、任务分工、策略与调用事实。                                                                                                                         |
| `packages/data/migrations/0032_unified_story_facts.sql`                              | 统一 StoryFact、不可变修订和旧记录链接。                                                                                                                                       |
| `packages/data/migrations/0033_causal_event_graph.sql`                               | 证据化、可重建的因果事件图。                                                                                                                                                   |
| `packages/data/migrations/0034_context_compilation_trace.sql`                        | 不含正文的上下文编译运行、条目和来源历史。                                                                                                                                     |
| `packages/data/migrations/0035_writing_feedback_learning.sql`                        | 用户可见、可控的反馈事件与写作偏好。                                                                                                                                           |
| `packages/data/migrations/0036_story_planning_candidates.sql`                        | 隔离、可编辑、可采纳/拒绝的 AI 剧情规划候选。                                                                                                                                  |
| `packages/data/migrations/0037_model_hub_expert_options.sql`                         | 不含秘密的专家认证、相对路径、超时和重试元数据。                                                                                                                               |
| `packages/data/migrations/0038_private_chapters.sql`                                 | 章节级仅本机状态、隐私修订和同步/导出门禁。                                                                                                                                    |
| `packages/data/migrations/0039_project_seeds.sql`                                    | 三条创建旅程共享、可修订的 ProjectSeed。                                                                                                                                       |
| `packages/data/migrations/0040_chapter_validation_snapshots.sql`                     | 绑定不可变章节版本的确定性检查快照。                                                                                                                                           |
| `packages/data/migrations/0041_story_planning_selective_acceptance.sql`              | 规划候选目标基线与逐项采纳回执。                                                                                                                                               |
| `packages/data/migrations/0042_chapter_validation_snapshot_delete_cascade.sql`       | 修复不可变检查快照在章节/项目删除与恢复时的级联语义。                                                                                                                          |
| `packages/data/migrations/0043_story_fact_entity_alias_resolution.sql`               | 仅允许受审计、带修订的实体别名人工消歧。                                                                                                                                       |
| `packages/data/migrations/0044_story_planning_selective_acceptance_intent.sql`       | 在正式大纲变更前持久预留逐项采纳意图。                                                                                                                                         |
| `packages/data/migrations/0045_project_remote_dispatch_leases.sql`                   | 不含用户内容的项目远程派发租约与窄隐私变更/删除防护；该临时表不进入恢复清单。                                                                                                  |
| `packages/data/migrations/0046_model_hub_zhipu_glm.sql`                              | 前向重建 Provider 连接约束，允许独立 GLM 连接类型并保留旧行/外键。                                                                                                             |
| `packages/data/migrations/0047_context_compilation_exact_provenance.sql`             | 上下文编译到 generation、调用事实和最终 Candidate 的不可变关联。                                                                                                               |
| `packages/data/migrations/0048_candidate_application_intents.sql`                    | Candidate 的任务意图、载荷形状、应用方式和 UTF-16 锚点。                                                                                                                       |
| `packages/data/migrations/0049_memory_governance_audit.sql`                          | 项目记忆忘却和两条人工合并的不可变前后快照审计。                                                                                                                               |
| `packages/data/migrations/0050_candidate_revision_authority.sql`                     | Candidate 单调修订、CAS 决定和内容校验权威。                                                                                                                                   |
| `packages/data/migrations/0051_model_hub_connection_commits.sql`                     | 不含密钥的 Model Hub 版本化凭据槽提交与补偿 journal。                                                                                                                          |
| `packages/data/migrations/0052_continuous_story_state_route_receipts.sql`            | 连续状态提取的版本、模型与完成计数收据。                                                                                                                                       |
| `packages/data/migrations/0053_writing_feedback_learning_policy_context.sql`         | 反馈发生时学习策略、自定义反馈哈希簇与可见偏好来源。                                                                                                                           |
| `packages/data/migrations/0054_writing_feedback_explicit_idempotency.sql`            | 明确反馈的项目级幂等身份；配合存储层把反馈事件与偏好同步放进单个事务。                                                                                                         |
| `packages/data/migrations/0055_continuous_story_state_historical_route_receipts.sql` | 允许合法历史版本回执随一致性备份恢复，同时保留版本归属与内容哈希校验。                                                                                                         |
| `packages/data/migrations/0056_model_hub_failure_diagnostics.sql`                    | 向能力扫描和调用事实追加可空、受约束的 request ID、失败阶段、HTTP/终止原因、可见长度、推理/流式标记、尝试和输出预算，并增加失败查询索引；不保存 Prompt、正文、模型回答或凭据。 |
| `packages/data/migrations/0057_model_hub_content_quality_task.sql`                   | 为 Model Hub 方案、路由与评测表前向补齐内容质量检查任务合同。                                                                                                                  |
| `packages/data/migrations/0058_story_settings_import_receipts.sql`                   | 保存 Story Settings 原子导入、冲突决定、撤销栅栏和重启恢复所需的操作收据。                                                                                                     |
| `packages/data/migrations/0059_generation_preflight_cost_status.sql`                 | 区分费用可估与供应商未提供价格；价格未知保留为可见警告，不误阻断基础写作。                                                                                                     |
| `packages/data/migrations/0060_novel_skill_registry.sql`                             | 默认关闭的 Novel Skill definition、项目 binding 与调用 snapshot。                                                                                                              |
| `packages/data/migrations/0061_novel_skill_evaluation_ledger.sql`                    | 不含题目和输出内容的付费评测账本、证据与人工决定链。                                                                                                                           |
| `packages/data/migrations/0062_project_dispatch_active_guard.sql`                    | 已有项目派发租约存续时禁止项目离开 active。                                                                                                                                    |
| `packages/data/migrations/0063_novel_skill_evaluation_paid_runner.sql`               | 精确付费目标、商业授权、费用上限、reservation 与盲评。                                                                                                                         |
| `packages/data/migrations/0064_novel_skill_evaluation_predispatch_authority.sql`     | 内容无关的 payload 子哈希、能力/目标锁和派发前估价权威。                                                                                                                       |
| `packages/data/migrations/0065_model_invocation_dispatch_boundary.sql`               | 在现有调用事实上持久不含内容的 Provider 发送边界。                                                                                                                             |
| `packages/data/migrations/0066_writing_experience_preferences.sql`                   | 写作模式、一次性本地整理授权与内容无关的 Provider 披露 grant。                                                                                                                 |
| `packages/data/migrations/0067_consistency_investigation_agent.sql`                  | 有界一致性调查 run、step、finding 和 evidence。                                                                                                                                |
| `packages/data/migrations/0068_writing_disclosure_active_grant_limit.sql`            | 披露 grant 上限只统计 active 行，保留 terminal 审计。                                                                                                                          |
| `packages/data/migrations/0069_consistency_investigation_invocation_reservation.sql` | 为调查模型 step 预留 content-free invocation UUID，并原子绑定调用账本与 context trace。                                                                                        |
| `packages/data/migrations/0070_multigranular_search_retrieval.sql`                   | 为可重建搜索投影追加多粒度范围、父子锚点、权威性、隐私与 currentness；旧行标记为 `legacy_unknown` 等待重建。                                                                   |
| `packages/data/migrations/0071_model_capability_probe_invocation_ledger.sql`         | 新增独立能力验证调用任务，让能力证据可空且唯一绑定精确终态调用记录，并在重建账本表时守恒既有行数。                                                                             |
| `packages/data/migrations/0072_ai_candidate_purpose.sql`                             | 为隔离结果增加不可变用途，方向选项不能被接受为正文；历史结果安全回填为正文用途。                                                                                               |
| `packages/data/migrations/0073_story_fact_user_revisions.sql`                        | 收紧用户故事事实内容修订与治理转换，保留事实身份、来源证据和修订递增约束。                                                                                                     |
| `packages/data/migrations/0074_chapter_version_story_fact_responsibility.sql`        | 在不可变章节版本上保存本地故事资料整理责任；旧行默认关闭，字段不可修改。                                                                                                       |
| `packages/data/migrations/0075_generation_attempt_privacy_snapshot.sql`              | 在新生成尝试上保存完整且不可修改的隐私快照和同一次模型调用标识；迁移前旧行保留空值。                                                                                           |
| `packages/data/migrations/0076_direct_local_story_fact_author_revision.sql`          | 为直接模式本地故事事实增加带审计的作者修订，不改变权威正文和不可变版本。                                                                                                       |
| `packages/data/migrations/0077_project_display_identities.sql`                       | 保存不含作品内容、可撤销且带修订历史的项目显示身份。                                                                                                                           |
| `packages/data/migrations/0078_generation_attempt_prose_invocation.sql`              | 不新增字段或表，只扩展不可变生成尝试隐私守卫，使续写与开头生成均可绑定精确 Model Hub 调用标识。                                                                                |
| `packages/data/migrations/0079_story_fact_evidence.sql`                              | 为一条受治理故事事实追加多处不可变正文依据，保留原始来源、作者决定和历史重复行。                                                                                               |
| `packages/data/migrations/0080_candidate_selection_action.sql`                       | 为新选区隔离结果冻结改写、润色、扩写或缩写的准确动作；历史记录允许空值并走明确兼容分支。                                                                                       |
| `packages/data/migrations/0081_story_fact_evidence_guard_performance.sql`            | 以一次 UTF-8 前导字节读取和有界递归保持精确 UTF-16 证据核对，避免长正文每条证据重复扫描整篇内容。                                                                              |
| `packages/data/migrations/0082_author_recovery_records.sql`                          | 追加项目级、按种类唯一、带 schema 版本和单调修订的作者恢复记录；JSON 载荷进入既有备份恢复保护范围。                                                                            |

当前六张写作体验/调查权威表全部进入既有备份删除与恢复顺序；`planned_invocation_id` 随
`consistency_investigation_steps` 整表恢复。当前恢复断言为 176 张表；唯一排除项仍是 1 张不含用户
内容的临时 `project_remote_dispatch_leases`，凭据值不进入备份。Tauri `74` 备份精确恢复能力扫描与
能力验证调用外键；从 Tauri `73` 旧备份恢复时，扫描表缺少该列会显式写入 `NULL`，正文、版本、
AI 建议草稿、任务、历史调用和旧能力证据仍按原值恢复。

## 8. `domain`：核心写作实体

| 文件                                              | 内容                                       |
| ------------------------------------------------- | ------------------------------------------ |
| `packages/domain/src/entities/ai-candidate.ts`    | AI 候选实体及其状态转换。                  |
| `packages/domain/src/entities/chapter.ts`         | 章节实体、内容修订和生命周期。             |
| `packages/domain/src/entities/chapter-version.ts` | 不可变章节版本快照。                       |
| `packages/domain/src/entities/project.ts`         | 项目实体、归档、回收站与恢复规则。         |
| `packages/domain/src/entities/project-seed.ts`    | 三条创建旅程共享的可恢复 ProjectSeed。     |
| `packages/domain/src/entities/recovery-draft.ts`  | 崩溃恢复草稿实体。                         |
| `packages/domain/src/index.ts`                    | 包的公开导出入口。                         |
| `packages/domain/src/ports/clock.ts`              | 可替换时钟端口。                           |
| `packages/domain/src/ports/uuid-v7-generator.ts`  | UUIDv7 生成端口。                          |
| `packages/domain/src/shared/app-error.ts`         | 领域与应用共用的结构化错误。               |
| `packages/domain/src/shared/result.ts`            | 显式成功/失败 `Result` 类型。              |
| `packages/domain/src/shared/value-objects.ts`     | UUID、时间、标题、正文等值对象解析和约束。 |

## 9. `import-export`：导入、导出与便携包

| 文件                                               | 内容                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/import-export/src/binary.ts`             | 加固 DOCX/PDF 导入：ZIP/path、外部 relationship、密码、大小、进度与取消检查。 |
| `packages/import-export/src/checksum.ts`           | 导入导出内容的 SHA-256 校验。                                                 |
| `packages/import-export/src/constants.ts`          | 格式版本、大小上限和受支持类型常量。                                          |
| `packages/import-export/src/core.ts`               | 四种发布格式共用的文本、二进制、压缩包与安全资源辅助。                        |
| `packages/import-export/src/docx-export.ts`        | 根据发布模型生成 DOCX。                                                       |
| `packages/import-export/src/epub-export.ts`        | 根据发布模型生成 EPUB 3，并保持正文与元数据边界。                             |
| `packages/import-export/src/errors.ts`             | 导入导出稳定错误码。                                                          |
| `packages/import-export/src/filename.ts`           | 安全文件名清理、扩展名和冲突处理。                                            |
| `packages/import-export/src/index.ts`              | 包的公开导出入口。                                                            |
| `packages/import-export/src/markdown-export.ts`    | 根据发布模型生成 Markdown。                                                   |
| `packages/import-export/src/pdf-export.ts`         | 将受控栅格页面封装为 PDF，避免在输出中引入脚本、附件或活动内容。              |
| `packages/import-export/src/portable-bundle.ts`    | InkShadow Bundle 的严格打包、解析、校验和与兼容性检查。                       |
| `packages/import-export/src/preflight.ts`          | 导入前格式、大小、文件名、内容和风险预检。                                    |
| `packages/import-export/src/publication-images.ts` | 内存图片资产解析、PNG CRC/JPEG 结构验证、尺寸/像素/数量/总量门禁。            |
| `packages/import-export/src/publication-model.ts`  | 将项目/章节转换为多种导出格式共享的发布模型。                                 |
| `packages/import-export/src/schemas.ts`            | 导入、便携包和 manifest 的严格 schema。                                       |
| `packages/import-export/src/story-settings.ts`     | 故事设定包的预检、解析与安全字段约束。                                        |
| `packages/import-export/src/text.ts`               | 纯文本/Markdown 解码、换行和 Unicode 规范化。                                 |
| `packages/import-export/src/text-export.ts`        | 根据发布模型生成纯文本。                                                      |
| `packages/import-export/src/vite-assets.d.ts`      | DOCX/PDF 运行时资源的 Vite 类型声明。                                         |

发布图片只接受安全内联 PNG、基线 JPEG 或调用方显式提供的内存项目资产；`path` 仅是资产键，
包不会据此读取磁盘或网络。单次最多 128 图、每图 4 MiB、总计 24 MiB、单边不超过 8192 像素且
总像素不超过 2000 万；PNG 必须通过 chunk/CRC 检查，JPEG 必须通过受限结构检查。Markdown 写入
data URI，DOCX/EPUB 写入真实 media 与 relationship，PDF 由调用方提供的本地 Blob 解码器取得像素后
执行 `drawImage`；缺图、坏图和超限一律失败，不会退化成文件名占位。

## 10. `observability`：脱敏诊断

| 文件                                        | 内容                                     |
| ------------------------------------------- | ---------------------------------------- |
| `packages/observability/src/diagnostics.ts` | 结构化诊断事件、健康快照和支持信息边界。 |
| `packages/observability/src/index.ts`       | 包的公开导出入口。                       |
| `packages/observability/src/logger.ts`      | 分级结构化日志接口与实现。               |
| `packages/observability/src/redaction.ts`   | 密钥、Token、正文和敏感字段的递归脱敏。  |
| `packages/observability/src/request-id.ts`  | 跨层请求 ID 创建和传播。                 |

诊断日志不能作为正文、Prompt、密钥或凭据的存储通道。
该包不包含遥测上传器。

## 11. `platform`：平台无关基础实现

| 文件                                                | 内容                                   |
| --------------------------------------------------- | -------------------------------------- |
| `packages/platform/src/crypto-content-hasher.ts`    | 基于 Web Crypto 的内容哈希实现。       |
| `packages/platform/src/crypto-uuid-v7-generator.ts` | 基于安全随机源和时钟的 UUIDv7 生成器。 |
| `packages/platform/src/index.ts`                    | 包的公开导出入口。                     |
| `packages/platform/src/system-clock.ts`             | 系统时钟实现。                         |

## 12. `search-core`：本地搜索与 Graph RAG

| 文件                                       | 内容                                             |
| ------------------------------------------ | ------------------------------------------------ |
| `packages/search-core/src/contracts.ts`    | 搜索文档、查询、结果、嵌入和索引端口。           |
| `packages/search-core/src/errors.ts`       | 搜索核心稳定错误。                               |
| `packages/search-core/src/graph-rag.ts`    | Graph RAG 节点、边、来源、遍历和上下文组装规则。 |
| `packages/search-core/src/hybrid-index.ts` | 关键词与向量结果的混合评分、去重和排序。         |
| `packages/search-core/src/index.ts`        | 包的公开导出入口。                               |
| `packages/search-core/src/tokenizer.ts`    | 中英文可预测分词和规范化。                       |

搜索核心不负责持久化，也不调用 embedding provider；持久化位于 `data`，embedding 由外部端口提供，相关 Feature Flag 当前默认关闭。

## 13. `story-core`：写作知识与创作工作流

### 13.1 领域模型与用例

| 文件                                                            | 内容                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/story-core/src/authoritative-extraction.ts`           | 从正文抽取权威事实时的领域记录和状态。                                           |
| `packages/story-core/src/authoritative-extraction-task.ts`      | 权威抽取后台任务负载和结果协议。                                                 |
| `packages/story-core/src/authoritative-extraction-use-cases.ts` | 权威抽取创建、完成、失败和应用用例。                                             |
| `packages/story-core/src/causal-event-graph.ts`                 | 因果事件、关系、证据、确定性影响遍历和图完整性规则。                             |
| `packages/story-core/src/character-voice-profile.ts`            | 人物声纹特征、台词证据、基线和确定性偏离检查。                                   |
| `packages/story-core/src/errors.ts`                             | Story Core 稳定错误码。                                                          |
| `packages/story-core/src/fine-tuning-governance.ts`             | 微调数据来源、同意、审批、保留和撤回治理。                                       |
| `packages/story-core/src/formal-record.ts`                      | 正式设定/事实记录模型。                                                          |
| `packages/story-core/src/formal-use-cases.ts`                   | 正式记录创建、修改、冲突和生命周期用例。                                         |
| `packages/story-core/src/ideation.ts`                           | 灵感空间、想法卡片和状态规则。                                                   |
| `packages/story-core/src/ideation-local-suggestions.ts`         | 不调用远程模型的本地灵感建议。                                                   |
| `packages/story-core/src/ideation-use-cases.ts`                 | 灵感创建、更新、排序和转化用例。                                                 |
| `packages/story-core/src/index.ts`                              | 包的公开导出入口。                                                               |
| `packages/story-core/src/legacy-memory-promotion.ts`            | 把兼容旧记忆显式提升为带来源与人工决定的 MemoryRecord；不会静默成为 canon。      |
| `packages/story-core/src/material.ts`                           | 素材条目、来源和分类模型。                                                       |
| `packages/story-core/src/material-use-cases.ts`                 | 素材创建、更新、检索和引用用例。                                                 |
| `packages/story-core/src/memory.ts`                             | 长期记忆条目、作用域和权威性模型。                                               |
| `packages/story-core/src/memory-use-cases.ts`                   | 记忆写入/读取、按项目忘却、人工两条合并、修订冲突和人工确认用例。                |
| `packages/story-core/src/narrative-analysis.ts`                 | 场景节奏、剧情线、伏笔、地点冲突和多线协调分析。                                 |
| `packages/story-core/src/novel-validator.ts`                    | 人物、关系、时间、地点、物品、能力、世界规则和知识的证据化验证。                 |
| `packages/story-core/src/outline.ts`                            | 大纲节点、层级、顺序和状态模型。                                                 |
| `packages/story-core/src/outline-use-cases.ts`                  | 大纲创建、移动、更新、删除和校验用例。                                           |
| `packages/story-core/src/ports.ts`                              | Story Core 共用时钟、ID、任务及事务端口。                                        |
| `packages/story-core/src/result.ts`                             | Story Core 的显式结果类型。                                                      |
| `packages/story-core/src/review-item.ts`                        | 审稿问题、证据、严重度和处置模型。                                               |
| `packages/story-core/src/review-use-cases.ts`                   | 审稿问题创建、确认、忽略和解决用例。                                             |
| `packages/story-core/src/safety.ts`                             | 文本、元数据、数量和跨项目引用安全校验。                                         |
| `packages/story-core/src/story-fact.ts`                         | 统一 StoryFact 状态、证据、分支、确认、锁定、废弃、实体别名人工消歧与更新策略。  |
| `packages/story-core/src/story-fact-use-cases.ts`               | StoryFact 创建、自动暂存、可重建替换、确认、实体别名消歧、治理和旧数据回填用例。 |
| `packages/story-core/src/value-objects.ts`                      | Story Core 使用的 ID、时间、标题和序号值对象。                                   |
| `packages/story-core/src/what-if.ts`                            | What-if 推演分支和候选模型。                                                     |
| `packages/story-core/src/what-if-use-cases.ts`                  | 推演创建、更新、比较和候选应用用例。                                             |

### 13.2 持久化实现

这些文件包含基于 SQLite 风格 SQL 的 repository 实现，但只依赖
`packages/story-core/src/persistence/executor.ts` 定义的自身 SQL port，不会反向依赖
`packages/data`。

| 文件                                                                         | 内容                                                             |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/story-core/src/persistence/authoritative-extraction-repository.ts` | 权威抽取 SQLite repository 实现。                                |
| `packages/story-core/src/persistence/common.ts`                              | 各 Story 仓储共用分页、修订和提交类型。                          |
| `packages/story-core/src/persistence/executor.ts`                            | Story 持久化所需参数化执行与事务端口。                           |
| `packages/story-core/src/persistence/fine-tuning-repository.ts`              | 微调治理 SQLite repository 实现。                                |
| `packages/story-core/src/persistence/formal-repository.ts`                   | 正式记录和时间线修订 SQLite repository 实现。                    |
| `packages/story-core/src/persistence/ideation-repository.ts`                 | 灵感 SQLite repository 实现。                                    |
| `packages/story-core/src/persistence/material-repository.ts`                 | 素材 SQLite repository 实现。                                    |
| `packages/story-core/src/persistence/memory-repository.ts`                   | 记忆 SQLite repository 与原子治理 Unit of Work；保留不可变审计。 |
| `packages/story-core/src/persistence/migration.ts`                           | Story 子系统迁移辅助和版本守卫。                                 |
| `packages/story-core/src/persistence/outline-repository.ts`                  | 大纲 SQLite repository 实现。                                    |
| `packages/story-core/src/persistence/review-repository.ts`                   | 审稿、章节版本读取和决定事务 SQLite repository 实现。            |
| `packages/story-core/src/persistence/story-fact-repository.ts`               | StoryFact、不可变修订、CAS 和旧记录链接 SQLite repository。      |
| `packages/story-core/src/persistence/what-if-repository.ts`                  | What-if SQLite repository 实现。                                 |

## 14. `sync-core`：端到端加密同步协议

| 文件                                             | 内容                                                           |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `packages/sync-core/src/chunk-crypto.ts`         | AES-GCM chunk 加解密、规范 AAD、4 MiB 分块和密文 manifest。    |
| `packages/sync-core/src/content-sync-payload.ts` | 项目、章节、版本等明文载荷的严格规范化、编码、大小和分块规则。 |
| `packages/sync-core/src/errors.ts`               | 同步核心稳定错误码。                                           |
| `packages/sync-core/src/index.ts`                | 包的公开导出入口。                                             |
| `packages/sync-core/src/sync-operation.ts`       | upsert/delete 同步操作实体。                                   |
| `packages/sync-core/src/tombstone.ts`            | 删除墓碑、设备观察和至少 365 天保留规则。                      |
| `packages/sync-core/src/transfer-ledger.ts`      | 密文块上传、确认和进度台账。                                   |
| `packages/sync-core/src/validation.ts`           | 同步标识符、时间、哈希、整数和常量时间比较校验。               |
| `packages/sync-core/src/version-vector.ts`       | 版本向量规范化、递增、合并、因果比较与入站变更决策。           |

服务端只能看到协议元数据和密文；客户端仍必须保证密钥不离开受信任边界，并验证快照、游标、块归属和 tombstone。

## 15. `task-engine`：耐久后台任务与通知

| 文件                                        | 内容                                                     |
| ------------------------------------------- | -------------------------------------------------------- |
| `packages/task-engine/src/backoff.ts`       | 带抖动的指数退避策略。                                   |
| `packages/task-engine/src/errors.ts`        | 任务错误、可安全展示的失败信息和下一步动作。             |
| `packages/task-engine/src/index.ts`         | 包的公开导出入口。                                       |
| `packages/task-engine/src/notification.ts`  | 通知级别、状态、路由、去重和生命周期。                   |
| `packages/task-engine/src/ports.ts`         | 任务/通知仓储和结构化任务日志端口。                      |
| `packages/task-engine/src/result.ts`        | 任务引擎显式结果类型。                                   |
| `packages/task-engine/src/safety.ts`        | 任务元数据白名单、大小限制和敏感值拒绝。                 |
| `packages/task-engine/src/scheduler.ts`     | 入队、领取租约、进度、失败重试、过期租约恢复与通知服务。 |
| `packages/task-engine/src/task.ts`          | 任务实体、租约和状态机。                                 |
| `packages/task-engine/src/value-objects.ts` | UUIDv7、时间、幂等键、任务类型、worker ID 等值对象。     |

任务引擎是可持久化的领域调度器，不是操作系统后台服务。

## 16. `test-utils`：仅测试辅助

| 文件                                 | 内容                                                 |
| ------------------------------------ | ---------------------------------------------------- |
| `packages/test-utils/src/builder.ts` | 可覆盖默认值的测试对象 builder。                     |
| `packages/test-utils/src/clock.ts`   | 可前进的确定性测试时钟。                             |
| `packages/test-utils/src/index.ts`   | 包的公开导出入口。                                   |
| `packages/test-utils/src/runtime.ts` | 强制仅在 `test` 运行时创建测试上下文，防止进入生产。 |
| `packages/test-utils/src/uuid.ts`    | 确定性 UUIDv7 测试工厂。                             |

## 17. `ui`：共享 React 视觉基础件

这个包属于前端基础设施，但放在共享包目录中；具体业务页面仍见 [`../front-end/PAGE_CATALOG.md`](../front-end/PAGE_CATALOG.md)。

| 文件                                            | 内容                                                         |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `packages/ui/src/components/app-shell.tsx`      | 应用外壳布局容器。                                           |
| `packages/ui/src/components/button.tsx`         | Button、IconButton、样式变体和尺寸。                         |
| `packages/ui/src/components/feedback.tsx`       | Toast、骨架屏、空/错状态、行内提示、保存状态和页面状态边界。 |
| `packages/ui/src/components/form-controls.tsx`  | Input、Textarea、Select 和 FormField。                       |
| `packages/ui/src/components/icon.tsx`           | 统一图标渲染、尺寸和无障碍语义。                             |
| `packages/ui/src/components/overlays.tsx`       | Dialog、Drawer、Dropdown、Tooltip 和焦点管理。               |
| `packages/ui/src/components/surfaces.tsx`       | Card、Badge 及其子结构。                                     |
| `packages/ui/src/components/table.tsx`          | 可访问的 Table 组合组件和排序状态。                          |
| `packages/ui/src/components/tabs.tsx`           | 受控/非受控 Tabs、键盘导航和 ARIA 关联。                     |
| `packages/ui/src/index.ts`                      | 包的公开导出入口。                                           |
| `packages/ui/src/lib/cn.ts`                     | 条件 className 合并辅助。                                    |
| `packages/ui/src/lib/use-controllable-state.ts` | React 受控/非受控状态 hook。                                 |
| `packages/ui/src/styles/components.css`         | 共享组件样式。                                               |
| `packages/ui/src/styles/index.css`              | 样式聚合入口。                                               |
| `packages/ui/src/styles/tokens.css`             | 色彩、间距、字体、阴影和状态设计令牌。                       |

## 18. 每个包根目录的常见文件

各包通常还包含：

| 文件                            | 内容                                                     |
| ------------------------------- | -------------------------------------------------------- |
| `packages/<name>/package.json`  | 包名、公开入口、命令和依赖；不是 npm 发布承诺。          |
| `packages/<name>/tsconfig.json` | 继承根严格 TypeScript 配置并声明包的编译范围。           |
| `packages/<name>/tests/**`      | 单元、契约、安全和持久化测试；测试名本身按被测行为组织。 |

数据库、Tauri、DOCX/PDF 和浏览器能力均通过端口或适配器进入，不应被领域包反向依赖。

## 19. 变更时如何维护本指引

- 新增、删除或移动 `packages/*/src` 文件时同步更新对应表。
- 新增本地 SQL 迁移时只追加版本，补充迁移用途，不能改写已经发布迁移。
- 修改 `contracts` 操作时，同时更新 Cloud 路由、客户端和接口文档。
- 修改 `ui` 组件时，同步检查 Desktop/Web 页面以及无障碍行为。
- 修改包依赖时运行边界检查，不能只依靠 TypeScript 能否编译。
