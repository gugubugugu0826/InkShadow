# 下一未发布增量：写作模式、叙事记忆与一致性调查现实矩阵

> 现实快照日期：2026-08-20  
> 当前源码基线：`b74d36ef3342db6813d1d43771bc82c0ed2aa1fb`（已发布标签 `v0.2.4`）  
> 当前工作树：`v0.2.5` Pre-release 候选，存在未提交修改；尚无唯一候选提交或安装包  
> 当前门禁：`PENDING_FINAL_RUN`  
> 外部验证：`PROVIDER_LIVE_NOT_RUN / REAL_TAURI_NOT_RETESTED`

本文只记录 `D:\InkShadow` 当前工作树的产品与数据事实。它不会把另一个工作区的 R12
报告、静态截图、fake gateway、临时 SQLite 或文件名相似的实现外推为当前安装版已验证。
最终测试数量与 bundle 字节必须等当前工作树停止变化后，由同一次最终门禁补录。本文只记录
本次已经生成并通过 checker 的 dirty HEAD 静态视觉 manifest 数量，不把它写成干净候选、真实
Tauri 或系统 DPI 证据。

## 证据边界

R12 四份报告来自历史工作区 `E:\InkShadow` 的提交 `6abd16c`：

- `InkShadow-v0.2.4-R12-UI视觉验收报告-2026-08-18.md`；
- `R12-第三阶段-真实预算全链路报告.md`；
- `R12-二至五阶段-真机UI实测与审核报告.md`；
- `第一阶段-功能核对报告.md`。

当前仓库不能解析该提交。报告里的 `auto-fact-extraction`、旧
`story-memory-read-model`、旧 `agent-investigation-runtime`、迁移 `0066`–`0069`、测试数量、
chunk 字节和真实调用结果均为 `HISTORICAL_ONLY`。其中真实 DeepSeek 调用属于
`REPORT_REAL_PROVIDER`，Tauri/WebDriver 操作属于 `REPORT_TAURI_UI`，截图审查属于
`REPORT_STATIC_VISUAL`，命令结果属于 `REPORT_AUTOMATED`；它们只用于提出验收要求。

远端只读审计确认 `v0.2.4` 已于 2026-08-14 公开为 Pre-release，tag peel 指向当前基线提交。
当前应用清单已准备为 `0.2.5`，但仍没有新的唯一提交、标签、安装包或发布结论。

## 状态定义

| 状态                                    | 本文含义                                           |
| --------------------------------------- | -------------------------------------------------- |
| `CURRENT_REPRODUCED`                    | 当前工作树已重新复现问题，不依赖 R12 结论          |
| `CURRENT_IMPLEMENTED_NOT_RETESTED`      | 当前代码入口存在，但最终统一门禁或目标环境尚未复测 |
| `CURRENT_UNVERIFIED`                    | 当前代码或目标环境尚无足够证据                     |
| `REPORT_*` / `HISTORICAL_ONLY`          | 只属于 R12 或其他历史快照                          |
| `PARTIAL`                               | 有安全、可用的当前切片，但未满足完整能力合同       |
| `DESIGN_ONLY`                           | 只有设计要求，没有当前生产闭环                     |
| `NOT_IMPLEMENTED`                       | 当前代码明确没有该能力                             |
| `DEFERRED` / `DEFERRED_CLOUD_EXECUTION` | 已确认留待后续，不属于当前生产能力                 |
| `BLOCKED_EXTERNAL`                      | 必须依赖真实凭据、目标 Windows、费用授权或外部环境 |

## R12 到当前工作树的映射

| 需求                                             | 当前状态                           | 当前代码入口                                                                                                                                                  | 报告证据                                               | 已有测试                                                                                                                                                                               | 缺口                                                                                                    | 是否修改                                                                                               |
| ------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 新用户默认直接、升级用户保留原工作方式           | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `writing-experience-store.ts`、`use-writing-experience.ts`、启动页、设置页、Data `0066` / Tauri `69`                                                          | R12 的直接模式仅是产品建议，不能证明当前实现           | 写作偏好 store、启动页、设置页用例；最终结果 `PENDING_FINAL_RUN`                                                                                                                       | 干净 Windows 首装、真实升级与备份恢复                                                                   | 是，在同一偏好权威上实现                                                                               |
| 首次启用直接模式的一次性本地整理授权             | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `direct-mode-authorization-dialog.tsx`、`writing_experience_preferences.direct_local_organization_authorized_at`                                              | R12 建议普通设定静默整理；没有当前授权实现证据         | 授权取消、保存、重开与 CAS 用例；最终结果 `PENDING_FINAL_RUN`                                                                                                                          | 安装版重启、恢复后只询问一次的人工复测                                                                  | 是；该授权明确不授予 Provider 调用                                                                     |
| 直接模式续写仍须显式接受 Candidate               | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `editor-page.tsx`、现有 Candidate/正文提交用例、`direct-writing-disclosure.ts`                                                                                | R12 真实长文属于提交 `6abd16c`，仅作验收输入           | 完整输出先持久化隔离 Candidate；两种模式都需作者选择“使用这版”；接受 append/CAS/旧版本与 0 Provider 用例已接线；最终结果 `PENDING_FINAL_RUN`                                           | 当前安装版长输出、崩溃边界、撤销和真实账本对账                                                          | 是；本地整理授权不再被解释为正文自动接受授权                                                           |
| 专业模式保留 Candidate 决定与高级应用方式        | `CURRENT_IMPLEMENTED_NOT_RETESTED` | 编辑器 Candidate 比较/接受/拒绝链、设置页写作体验开关                                                                                                         | R12 专业模式页面和长 Candidate 是历史 UI/Provider 证据 | 现有 Candidate 路由、比较、接受/拒绝和版本测试；最终结果 `PENDING_FINAL_RUN`                                                                                                           | 当前两主题、长文本与真实 Tauri 键盘复测                                                                 | 在原链上收口，不复制编辑器                                                                             |
| 生成完成后本地整理普通设定                       | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `direct-story-fact-organizer.ts`、现有 `StoryFactApplicationService`                                                                                          | R12 的云端自动提取不属于当前实现                       | 确定性提取、幂等、过期版本和失败不回滚用例；最终结果 `PENDING_FINAL_RUN`                                                                                                               | 规则覆盖仍保守；真实作品的误报/漏报需观察                                                               | 是；当前实现严格本地、0 Provider                                                                       |
| 重大设定继续拦截确认                             | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `stageAutomaticFact` 与现有待确认治理链                                                                                                                       | R12 建议死亡、身份、核心关系、世界规则等重大项拦截     | 重大分类、未确认/needs-review 与通知用例；最终结果 `PENDING_FINAL_RUN`                                                                                                                 | 当前规则不是完整语义理解；不得把未识别写成已整理                                                        | 是；重大项不会自动进入 canon                                                                           |
| Candidate 接受后精确 0 次隐藏云调用              | `CURRENT_IMPLEMENTED_NOT_RETESTED` | 既有 accepted-version 本地派生管线、Candidate 接受事务                                                                                                        | v0.2.3 隐式云调用是更早历史缺陷；R12 不替代当前证据    | fake gateway 与真实临时 SQLite 已覆盖接受、版本、重启和派生失败；最终全链仍 `PENDING_FINAL_RUN`                                                                                        | 新安装包的 Provider 控制台对账                                                                          | 沿用 P0 修复；本轮本地整理仍无 gateway                                                                 |
| 普通 UI 不显示内部错误码                         | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `ui-error.ts` 及页面集中式投影                                                                                                                                | R12 截图记录两个裸内部码                               | 映射与受影响页面用例；最终结果 `PENDING_FINAL_RUN`                                                                                                                                     | 全页面错误矩阵与真实 WebView 复测                                                                       | 是，不在页面散落码值拼接                                                                               |
| 长 Candidate 与有效 CSS viewport                 | `CURRENT_IMPLEMENTED_NOT_RETESTED` | Candidate Dialog、编辑器布局合同、视觉 E2E                                                                                                                    | R12 只证明历史截图的部分长度；主题/视口元数据存在缺陷  | Candidate 共享决策链 7 files / 59 tests PASS；长文本、固定动作区和布局合同已覆盖；最终 Chromium matrix `PENDING_FINAL_RUN`                                                             | 真实 Windows 系统 200% DPI、50,000 字与两主题人工复测                                                   | 是；不能用 CSS zoom 冒充系统 DPI                                                                       |
| 深色侧栏、首页/开书底部和正文滚动                | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `styles.css`、Shell/启动/开书/编辑器布局合同与响应式 E2E                                                                                                      | R12 记录无溢出却显示滚动条、首屏/动作裁切和多层滚动    | 真实 overflow、吸底动作、主内容宽度和窄屏 Drawer 用例；最终结果 `PENDING_FINAL_RUN`                                                                                                    | 浅/深目标矩阵、真实滚动、键盘焦点和系统 200% DPI                                                        | 是；单文件 CSS 预算守卫保持不变                                                                        |
| SQLite reload 复用单一原生连接                   | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `native_sqlite.rs`、`tauri-sqlite.ts`、`runtime-context.tsx`                                                                                                  | R12 在另一工作区复现 `SQLITE_ALREADY_OPEN`             | 并发前端 open 合并、session token 轮换、孤立事务回滚与原生 reload 用例；最终结果 `PENDING_FINAL_RUN`                                                                                   | 当前安装版 WebView reload、初始化中 reload 与长期重启                                                   | 是；不打开空替代库，不覆盖原库                                                                         |
| 手动设定表单打开、预填和焦点返回                 | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `story-settings-tools.tsx`、设定治理页面                                                                                                                      | R12 在提交 `6abd16c` 的真机路径通过                    | 当前结构化对话框、取消 0 写入/0 Provider 与焦点用例；最终结果 `PENDING_FINAL_RUN`                                                                                                      | 当前安装版键盘、reload 与双 overlay 复测                                                                | 复用既有表单，不建平行页                                                                               |
| 统一 `EvidenceRef` 和 `StoryMemoryReadModel`     | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `packages/ai-core/src/story-memory-read-model.ts`、Desktop 组合读模型、Narrative State                                                                        | R12 的同名类不能外推                                   | L0–L3、current/stale、隐私、分支、未确认/rejected 排除、Narrative 重建和 MemoryRecord 明确提升用例；最终结果 `PENDING_FINAL_RUN`                                                       | 安装版端到端证据下钻与长篇人工质量复测                                                                  | 是；只读组合现有权威，没有第二事实库                                                                   |
| FTS 始终为检索基线                               | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `project-search.ts`、多粒度搜索投影与现有索引                                                                                                                 | R12 的 bundle/搜索数字是历史证据                       | 向量、Ollama 或 query embedding 失败时仍返回 FTS；固定六臂本地对照已完成，production 默认仍保留简单 FTS                                                                                | 冻结 commit 的 production benchmark 仍 `FINAL_BENCHMARK_PENDING`；可选 vector/graph/rerank 不会自动开启 | 是；可选能力失败不清空本地命中，也不触发 Provider                                                      |
| 有界本地 query rewrite / multi-query / recovery  | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `bounded-local-retrieval-query-plan.ts`、consistency tool registry、continuation runtime                                                                      | 新增工程 Prompt 是目标，R12 没有当前实现证据           | 最多 4 条/每条最多 80 字符、确定性去重与兼容字形；续写和调查覆盖 `initial → rewrite → expand_k → evidence_insufficient` 的有界恢复与 content-free trace                                | 最终 Desktop/production 全链仍 `PENDING_FINAL_RUN`；不扩大隐私范围、不转远程检索                        | 是；纯本地、不能构造 SQL，证据不足时失败关闭                                                           |
| content-free `queryTrace`                        | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `SearchToolObservation.queryTrace`、`redactedObservationReceipt`                                                                                              | R12 trace 不能外推                                     | 持久 digest 的输入只含来源 ID、类型、方法、结果数和权重，不含 query/正文                                                                                                               | 真实诊断导出与安装版隐私审计尚未跑                                                                      | 是；本次内存观察可含 query，SQLite 只保存 redacted receipt digest                                      |
| 检索指标与 FTS/rerank 固定对照                   | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `retrieval-evaluation.ts`、`long-form-retrieval-benchmark.ts`                                                                                                 | 不使用 R12 的 19 条结论充当 benchmark                  | Recall/Precision/MRR/nDCG/hit/authority/stale/rejected/private 指标；六臂本地矩阵对比 FTS、vector、local rerank、graph+rerank、weighted fusion 与 grouped RRF，0 dispatch              | production SQLite runner 的原始 JSON/汇总仍 `FINAL_BENCHMARK_PENDING`                                   | 是；对照完成不改变默认 FTS，也不冒充冻结生产结论                                                       |
| StoryFact→Graph / Narrative / TaskGraph          | `CURRENT_IMPLEMENTED_NOT_RETESTED` | authoritative StoryFact graph projection、Narrative State read model、consistency TaskGraph                                                                   | R12 的平行实现不能证明当前链路                         | 权威 StoryFact 投影到可重建图；Narrative 从当前接受版本重建；TaskGraph 从同一 run/step/tool/evidence 链只读投影并支持重启重建                                                          | 冻结后的 graph/restart/restore 全链与真实 Tauri 下钻仍待复跑                                            | 是；不建立第二事实源，任一投影失败都不回滚 accepted 正文                                               |
| Production Agent：长篇一致性调查                 | `CURRENT_IMPLEMENTED_NOT_RETESTED` | 检查页 `ConsistencyInvestigationPanel`、service/store/tool registry、Data `0067`/`0069`、Tauri `70`/`72`                                                      | R12 的 6 次/20 步/19 条结论属于历史 Agent              | 固定只读工具、单次模型、双阶段精确披露、完整 authority fingerprint 双重重检、planned invocation、ledger/task 恢复、迁移与备份已接线；2 files / 36 tests PASS                           | 通用自适应 Agent 明确不在当前合同；真实 Provider/Tauri 为 `BLOCKED_EXTERNAL`                            | 是；复用 task、invocation、trace、StoryFact、搜索和 causal graph                                       |
| Agent 根据 Observation 自适应 replan             | `NOT_IMPLEMENTED`                  | 当前服务按固定本地工具顺序执行后做一次模型综合                                                                                                                | R12 历史运行不能证明当前实现                           | 无                                                                                                                                                                                     | 若未来实现，必须继续使用固定 allowlist 和每步持久边界                                                   | 否，当前明确不冒充完整 Agent                                                                           |
| 从调查结果生成修复 Candidate                     | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `consistency-repair-candidate-service.ts`、`consistency-repair-candidate-recovery.ts`、调查面板、既有 task/Model Hub/trace/output commit/Candidate/版本接受链 | R12 只提出按钮/流程要求                                | 聚焦 fake + SQLite 覆盖确认前 0 call、确认后 1 call/0 retry、精确证据 trace、隔离 Candidate、无效输出、发送后取消 ambiguous，以及 planned/bound/dispatched/迟到成功的重启终结与 0 重发 | 真实 Provider/Tauri、长章质量与人工接受交互仍待第二阶段复测                                             | 是；没有第二 Candidate/调用/task/trace store，也不直接改正文；修复 loadout 暂限 L0/L1 精确 EvidenceRef |
| 确认后/dispatch 后 fallback / 多 invocation 收据 | `DEFERRED`                         | 发送前可按已配置 route `use_fallback` 选模；policy 仍固定最多 1 次模型、0 网络重试                                                                            | 增量 Prompt 的未来要求                                 | 最终实际 Provider/model 必须披露并绑定；确认后、not_dispatched、ambiguous 不自动换模或重发                                                                                             | 多次尝试需逐次授权、预算、幂等、独立 invocation 和恢复合同                                              | 否；不得把多调用藏入一次调查                                                                           |
| 多粒度 chunk 与 production benchmark runner      | `CURRENT_IMPLEMENTED_NOT_RETESTED` | Data `0070`、范围化 FTS、production benchmark runner                                                                                                          | 增量 Prompt 是当前实现要求                             | 当前 Data 70 files / 432、AI Core 19/129、Search Core 3/34 PASS；六类 chunk、父子定位、范围排除和 5k/20k/50k/200k、≥30 样本 runner 已接线                                              | 唯一冻结 commit 上的原始 benchmark 与汇总仍 `FINAL_BENCHMARK_PENDING`；云端执行仍延期                   | 是；实现只复用现有本地 SQLite/搜索/调查路径，不引入云端平面                                            |
| `0066`–`0070` 与完整备份恢复                     | `CURRENT_IMPLEMENTED_NOT_RETESTED` | 五个 forward-only migration、Tauri `69`–`73`、`maintenance.ts`                                                                                                | R12 的同号迁移内容不能充当当前实现证据                 | 当前 Data 70 files / 432 tests PASS；70 Data + 3 story-core、planned invocation、0070 范围列、172 表恢复与 ledger/task 对账均覆盖                                                      | 冻结候选 release 门禁和安装版旧库升级/恢复                                                              | 是；没有改写既有 migration/checksum                                                                    |
| 四格式安全图片嵌入与保存回执                     | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `@inkshadow/import-export`、`browser-pdf-page-rasterizer.ts`、`native_export_artifact.rs`、Data Transfer Panel                                                | R12 没有当前代码证据                                   | import-export 11 files / 90、rasterizer 4/4、save Vitest 16、Rust 5/5、E2E 1/1；内部格式与写后 size+SHA 真实校验                                                                       | 真实 Tauri 保存对话框与四个外部应用打开仍 `BLOCKED_EXTERNAL`                                            | 是；浏览器只记 `path_not_available`，不冒充已验证路径                                                  |
| Provider 动作精确披露与隐藏入口关闭              | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `provider-action-disclosure.ts`、各动作 prepare/confirm 链、普通 UI 错误投影                                                                                  | R12 不能证明当前入口                                   | 续写精确披露 31/31；opening 四类动作 2 files / 79 tests；旧导入 Provider 入口关闭且历史 Candidate 显式决定链 5/5；取消/漂移与接受阶段均 0 call                                         | 真实 Provider 对账仍 `BLOCKED_EXTERNAL`；settings 冻结静态全入口审计待收口                              | 是；旧 route fallback、普通 AI review、新导入生成与普通向量重建保持关闭                                |
| 新静态视觉证据与哈希去重                         | `CURRENT_IMPLEMENTED_NOT_RETESTED` | `desktop-visual-evidence.spec.ts`、`check-visual-evidence.mjs`                                                                                                | R12 主题颠倒、重复截图、状态失配和视口错误是历史缺陷   | 当前 dirty HEAD 静态 Chromium manifest 为 32 条、32 个不同 SHA-256 PNG                                                                                                                 | 不是干净候选；真实 Tauri/系统 DPI 仍 `NOT_RUN`                                                          | 是；产物继续在 Git ignore 范围                                                                         |
| `Design-temp/` 转为正式设计                      | `DESIGN_ONLY`                      | 当前仍是用户未跟踪目录                                                                                                                                        | 不是 R12 代码证据                                      | 无                                                                                                                                                                                     | 本轮明确禁止移动、删除或提交；需后续单独授权和冲突审计                                                  | 否                                                                                                     |

## 两种写作模式共用的安全链

直接模式和专业模式只改变交互与默认值，不改变数据权威：

1. Provider 成功结果先创建并持久化隔离 Candidate；
2. 私密、partial、truncated、空可见文本、reasoning-only、ambiguous、版本冲突、目标失效、
   整章/跨章或其他破坏性操作不会自动应用；
3. 直接模式也只展示隔离 Candidate，不根据“本地整理”授权自动接受正文；作者必须明确选择
   “使用这版”或“放弃”；
4. 只有显式选择使用后，现有接受事务才写入正文、创建新不可变版本并标记 Candidate accepted；旧版本保留；
5. 专业模式保留更多应用方式与比较控件，但与直接模式使用同一 Candidate、正文替换 fence 与版本合同；
6. 模式切换本身为 0 Provider、0 正文修改、0 Candidate 删除、0 路由改动；生成中切换只影响
   下一次操作；
7. Candidate 接受后的所有默认派生必须为本地可重建操作，失败不得回滚已接受正文。

首次启用直接模式时，应用单独说明并保存“本地整理”授权。该授权不包含 Provider、模型、正文
外发、费用或重试权限。远程续写仍使用独立的、绑定精确 Provider/model/任务/发送范围/调用数/
重试/费用状态/隐私的披露 grant；任一范围变化必须重新披露。

## 普通设定与重大设定

直接模式中，只有作者明确接受 Candidate 后，才对该**当前不可变版本的新增 delta**运行保守、
确定性的本地整理：

- 普通设定进入现有 StoryFact 链并保留版本、UTF-16 位置和摘要哈希；正常界面只显示
  “已整理 N 条”；
- 死亡、身份/核心名称、核心关系、世界规则、重大时间线和 POV 等重大设定保持未确认并进入
  现有待确认治理；不会静默升级为 canon；
- 过期版本、重复证据和无法明确识别的 prose 会跳过；
- 整理服务没有 gateway、route、credential、invocation、retry 或网络依赖；
- 整理失败只影响可重建派生，不影响刚完成的正文和不可变版本。

## StoryMemory、FTS 与图投影

当前 `StoryMemoryReadModel` 是应用层只读组合，不是新数据库：

- L0 来自当前接受正文及不可变版本证据；
- L1 只接纳确认 StoryFact；
- L2 复用现有叙事状态/记忆兼容资料，并显式记录 disabled、excluded、stale 和隐私排除；
- L3 只把已确认 ProjectSeed 字段放入项目核心；
- rejected Candidate、unconfirmed、temporary、needsReview、deprecated、其他分支与远程不可用的
  私密证据不会进入权威层；
- `EvidenceRef` 只存定位、摘要和来源身份，不把整段正文复制进多个事实表；
- FTS/关键词检索是无向量时仍可用的基线，向量与 causal/legacy graph 只是可选投影。

`NarrativeStateReadModel` 以当前接受版本和权威证据重建可派生叙事状态，失败不回滚正文。旧
`MemoryRecord` 不会因被读取就成为 canon；只能经明确提升进入现有 StoryFact 治理链。
这两者都不新建平行事实库。

一致性调查和 active continuation 已共用有界本地 query rewrite/multi-query/recovery：从权威
L1/StoryMemory 生成 fact、alias、time、location 或 fallback 查询，最多 4 条、每条最多 80
字符，依次记录 `initial`、本地 `rewrite`、有界 `expand_k`，仍不足则明确
`evidence_insufficient`；失败只记本地证据不足/`fts_query_failed_without_remote_fallback`，不会改用
Provider 或扩大隐私范围。生成持久 `observationDigest` 前的
redacted receipt 里，`queryTrace` 只含来源条目 ID、查询类型、`fts`、结果数和 fusion weight；
SQLite 只保存该 receipt 的 digest，不保存 query、正文或 receipt 本体。查询文本只在本次内存观察
中使用。

纯本地检索评估函数已覆盖 `Recall@K`、`Precision@K`、MRR、nDCG、hit rate、authority
precision、stale hit rate、rejected Candidate contamination rate 与 private leakage count。固定
六臂本地矩阵已经比较 FTS baseline、FTS+vector、local rerank、graph+local rerank、weighted
fusion 和 grouped RRF，且保持 0 Provider/0 network；它是确定性对照，不是冻结 commit 的
production SQLite 结论。当前产品默认仍保留简单 FTS，不因对照结果自动启用 vector、graph 或
rerank。

Data `0070` 已为可重建搜索投影表达 chapter、scene、event、paragraph、dialogue 和
story-fact-evidence 六类 chunk，并保存父子定位、UTF-16 范围、currentness、authority、privacy、
branch、POV、story order/time 及 scene/event/人物/地点范围。旧投影升级为 `legacy_unknown`，在权威源重建前
不冒充当前证据。Agent 的 FTS-only 入口不会因向量不可用而隐式调用 embedding 或写搜索快照。

长篇 benchmark runner 已覆盖 5k/20k/50k/200k 与不少于 30 个语义样本，但它强制绑定唯一冻结
source revision。在该 commit 存在并实际生成原始 JSON 前，状态只能是 `FINAL_BENCHMARK_PENDING`。
权威 StoryFact→可重建 Graph 投影、Narrative State 只读重建与一致性 TaskGraph 已接线；可选
vector/graph expansion/remote rerank 不会被自动启用，自动多模型 fallback 与云端 Agent 仍安全关闭，
因此不把这些当前实现外推成另一套事实源或通用“GraphRAG 平台”。

## Production Agent 当前边界

“检查 → 长篇一致性调查”是第一条生产切片，不是通用自治 Agent：

- 进入页面和准备范围阶段不派发模型；发送前显示章节数、估算 token、本机/远程去向、连接显示名、
  Provider、精确模型、最大 1 次模型调用、固定 5 个本地工具步骤、0 自动重试、费用上限或未知、
  发送/不发送范围和中断规则；
- 工具注册表只允许 StoryMemory、确认事实、FTS、causal graph 和确定性证据核验的本地只读操作；
  不开放 shell、任意 SQL、文件、网络、credential 或正文写入；
- 正文、检索片段和工具观察一律是不可信数据，不能改变系统权限或伪造 tool call；
- 正式 finding 只能引用当前已接受正文或确认 StoryFact 的精确 `EvidenceRef`；
- run、step、model invocation、context trace、finding、evidence 和 task center 使用同一状态链；
- 取消、崩溃与结果不明确不会自动重发；越过派发边界但结果未知时进入 `ambiguous`；
- 完整调查 factory 按检查页需求加载；启动恢复使用独立轻量入口，不把完整 Agent 工具链静态塞进
  普通启动图；工作树后续仍有变化，最终 chunk 文件名与字节保持 `FINAL_BUILD_PENDING`；
- `partial` 不冒充成功，结果支持严重度、类别、权威来源筛选以及忽略/标记允许；
- 只读 `TaskGraph` 把同一 run/step/tool/observation/finding 投影为“目标 → 计划 → 行动 → 工具 → 观察 →
  核验 → 结果/阻断”；重启只重建展示，不续跑或派发；
- Agent 不修改正文。finding 的修复入口是调查之外的独立动作：选择当前证据章节后先做 0-call 预检，
  单独披露精确 Provider/model/task、范围、费用、隐私、1 call/0 retry，再由作者确认。确认后复用既有
  task、Model Hub invocation、Context Compiler trace 与原子 Candidate 输出提交；严格结构只允许一处
  连续补丁，本地合成完整章节 Candidate。EvidenceRef 与 Candidate 通过同一 trace 关联，取消、无效
  输出、known failure、ambiguous、重启和正文/版本漂移均不会重发或写正文。接受仍复用编辑器的
  Candidate CAS 与不可变版本事务，精确增加 0 次 Provider 调用。
- 调查与修复的授权彼此独立。完整 Model Hub inspection authority、全部 capability evidence、
  connection display、隐私、context/messages 会在各自确认后和最终 dispatch 前重读；route、价格、
  目的地、能力、正文或证据任一漂移均为 0 Provider 并要求重新确认。该链聚焦回归 2 files /
  36 tests PASS，5 文件 ESLint/Prettier PASS。

当前有界 Production Agent 合同已实现但尚待冻结全量复跑；它按固定 allowlist 顺序收集观察后做
一次模型综合与本地验证，不是通用 Tool Call → Observation → 自适应 Replan 循环。自适应 replan
是明确的未来范围，不能用它把当前已完成的有界流程继续标成含糊 `PARTIAL`。发送前允许按已配置 route
的 `use_fallback` 选择并披露实际模型，但仍只有 1 个 invocation、0 网络重试；确认后/dispatch 后
自动 fallback、多 invocation fallback 收据和云端执行仍分别为 `DEFERRED` / `DEFERRED_CLOUD_EXECUTION`。
多粒度 chunk 已实现；production benchmark runner 已接线，但唯一冻结 commit 上的原始结果仍是
`FINAL_BENCHMARK_PENDING`。实际架构与虚线边界见
[`13-LOCAL-AGENT-RAG-ARCHITECTURE.md`](13-LOCAL-AGENT-RAG-ARCHITECTURE.md)。

## Provider 动作披露与关闭入口

当前已完成聚焦审计的续写与 Provider 动作把 prepare 与 dispatch 分开。发送前普通界面显示连接显示名、精确模型、任务、
会发送/不会发送的内容、本地或远程去向、精确最大 Provider 调用数、0 自动重试、费用上限或费用未知，
并将这些权威与当前 connection/catalog/model revision 绑定到 fingerprint。确认缺失或任一权威漂移时在派发前
失败关闭，Provider 调用增量为 0。快速 AI 连接与设置页的固定能力探针也不例外：它们在固定短句生成前显示精确
目标、1 次调用、0 次重试、最多 64 输出 token、可能少量收费，且明确不发送作品正文、灵感、设定或 API Key。
专业/直接续写共用 `continuation-generation-disclosure.ts`：prepare 为 0 call，确认和 Provider 边界前都复核完整
inspection/pricing/privacy/source/version fingerprint。直接模式只能复用同一精确 fingerprint 的持久 grant；价格、路由、隐私或源版本漂移均为 0 dispatch。
opening 四类动作的聚焦链已 2 files / 79 tests 通过，覆盖二次确认、取消 0-call 和
route/cost/source/privacy 最终复核；Settings 固定能力探针 3 files / 69、图片/编辑器 3 files / 46、
调查/修复 2 files / 36 也已通过。Settings 两个固定文本 probe 最终另以 1 file / 55 tests 通过点击
冻结、fingerprint authority、同一 prepared input 持久化和派发前权威重检；四类漂移 0 call，成功
精确 1 call。豆包 Endpoint ID 非空时作为同一有效模型贯穿披露、保存与派发，Provider dispatch
surface 当前无剩余 P0/P1。冻结全量仍为 `PENDING_FINAL_RUN`，上述合同不能提前外推为全入口
最终证明。

当前可达 Provider 面只包含编辑器续写/选区改写、故事规划、调查/单条修复、图片、Model Hub
本地评测、快捷连接/Settings 固定文本/结构化/翻译 probe 与 opening。Candidate 接受、普通正文检查、
接受后的本地整理和本地派生均为 0 Provider。旧检查 AI、无授权摘要/连续状态、translation/
short-drama governed dispatch 和普通搜索 vector/rerank 已关闭；权威提取需双特性开关，
Multi-Agent 默认关闭且受 guard，rerank 没有 production caller。设置页“撤销本地整理授权”满足
本轮关闭/撤销要求；普通 UI 逐 Provider grant 管理不是当前 requirement。

与此同时，旧续写路由 fallback、普通章节检查的隐式 AI review、导入批处理隐藏 Agent、未授权的连续状态/摘要和
普通项目搜索中的向量重建入口均保持关闭。缺失 route、credential、capability 或 Provider 输出时显示 skipped/failed，
不调用 legacy gateway，不制造看似 Provider 的伪结果。
旧导入 Provider 生成入口关闭后，已经保存的隔离 Candidate 仍可查看并显式接受、拒绝或恢复；定向
5/5 回归证明接受阶段 0 Provider 并创建新不可变版本。新的导入试改/逐章生成在完整披露链完成前不派发。

## 四格式图片导出与保存回执

导出只接受安全内联 PNG、基线 JPEG 或项目明确交付的内存资产。`path` 只是项目内资产键，导出器不从磁盘或网络补读。
边界是 128 张图、每图 4 MiB、总计 24 MiB、最大边长 8192 和 2000 万像素；PNG 必须通过 CRC，JPEG 必须通过基线结构验证。
Markdown 写 data URI，DOCX/EPUB 写真实 media 与 relationship，PDF 在本地把 Blob 解码成图像并绘制到图像页。

Tauri 保存使用原生对话框签发的一次性 ticket，写入前验证父目录与已选目标的身份，对新文件使用 no-clobber 安装，
对已选现有文件使用原子替换；最终必须回读大小与 SHA-256。成功回执显示 format、fileName、绝对 path、byteLength 和 status；
取消是 0 写入，失败错误不泄露路径。浏览器只能标记 `browser_download / path_not_available`，不宣称已核验保存路径。
真实 Windows Tauri 保存对话框与四个外部应用的实际打开仍是 `BLOCKED_EXTERNAL`。

## 数据迁移与恢复

- Data `0066_writing_experience_preferences.sql` / Tauri `69` 追加写作模式、本地整理授权和内容
  无关的 Provider 披露 grant；升级数据库在首次权威读取时保守推断专业模式，新安装推断直接
  模式。
- Data `0067_consistency_investigation_agent.sql` / Tauri `70` 追加有界调查 run、step、finding 和
  evidence；task、invocation、trace、正文、Candidate 与 StoryFact 仍使用既有表。
- Data `0068_writing_disclosure_active_grant_limit.sql` / Tauri `71` 只把披露 grant 的 128 条上限
  修正为统计 `active` 行；terminal grant 继续保留审计，不借提高上限绕过重新授权。
- Data `0069_consistency_investigation_invocation_reservation.sql` / Tauri `72` 在 model step 上预留
  content-free invocation UUID，并在账本创建时原子绑定 step/context trace。启动恢复按
  `provider_dispatch_started_at` 区分发送前与发送后：分别把 running ledger/run 结清为
  `cancelled`/`not_dispatched` 或 `timed_out`/`ambiguous`；terminal run 对应的非终态 task 同步对账为
  succeeded/cancelled/failed，且不自动重发。
- Data `0070_multigranular_search_retrieval.sql` / Tauri `73` 只扩展可重建搜索投影：追加多粒度类型、
  父子/UTF-16 定位、currentness、authority、privacy 与 branch/POV/story-time 等范围列。旧行为
  `legacy_unknown`，必须从权威源重建后才可充当当前检索证据。
- 当前是 70 个 Data migration + 3 个 story-core migration，即 Tauri internal `73`。
  `maintenance.ts` 已把偏好、grant 和四张调查表共六张权威表纳入既有完整备份的删除/恢复顺序，
  恢复断言为 172 张表；`planned_invocation_id` 随 investigation step 整表复制，凭据值仍不进入备份。
- 当前迁移只向前追加，没有改写已发布 migration 或 checksum。最终迁移、真实临时 SQLite、
  备份/恢复和旧库升级结果仍待主线门禁统一补录。

## 验收与发布边界

当前可由自动化关闭的只包括相应代码合同；`PENDING_FINAL_RUN` 不能写成发布通过。当前 dirty
HEAD 的静态 Chromium 视觉证据已验证 32 条 manifest 对应 32 个不同 SHA-256 PNG；runtime 是
`static_web_distribution`，`tauriWebView=not_run`、`systemScale=not_measured`。它只关闭静态
截图证据本身，不关闭真实 Tauri、系统 200% DPI、键盘、滚动或干净候选验证。主线最终证据
必须分别记录单元/集成、真实临时 SQLite、Rust/Tauri migration、TypeScript、ESLint、Prettier、
`git diff --check`、production build、bundle graph、Playwright 和完整 `release:check` 的精确命令
与结果。工作树尚未形成干净唯一提交时，`release:check` 的干净树门禁可以预期拒绝，不能因此
提交或绕过检查。

以下项目只能留给独立第二阶段测试：

- 当前工作树构建的真实 Windows Tauri/Wry/WebView2；
- 系统 200% DPI、键盘、焦点、Escape、焦点返回和真实滚动；
- Windows Credential Manager、WebView reload、安装/升级/卸载/重装；
- 真实 Provider、直接模式账本对账、长输出、断流/超时/401/429 与 Agent 调查；
- 真实 Tauri 保存对话框与 Markdown/DOCX/PDF/EPUB 在四个独立外部应用中打开；当前结构解析、图片嵌入、
  浏览器下载状态与 Rust 写后回读已有本地自动化，但不替代该外部验收；
- 真实备份恢复和崩溃点恢复。

独立执行说明见
[`../execution/NEXT-UNRELEASED-WINDOWS-TAURI-PHASE-2-PROMPT.md`](../execution/NEXT-UNRELEASED-WINDOWS-TAURI-PHASE-2-PROMPT.md)。
