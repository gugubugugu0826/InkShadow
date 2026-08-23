# v0.2.5 已发布：写作模式、叙事记忆与一致性调查现实矩阵

> 现实快照日期：2026-08-20  
> 当前公开状态（2026-08-23）：应用清单为 `0.2.7`；最新公开版本为 [`v0.2.7`](https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.7) 未签名工程预发布  
> source commit：`5b3e212cafde10cd75fa87b7b74bfdfff9347a3d`；tag object：`51dfd64ba22e9771131f251cdc778ee06f89192d`  
> 本文所述 `v0.2.5` 冻结门禁：`RELEASE_VERIFIED`  
> 外部验证：`BLOCKED_EXTERNAL`（真人 Windows Tauri/Wry、真实 Provider、系统 200% DPI、外部应用打开）

本文记录 `v0.2.5` 冻结发布源的产品与数据事实。它不会把另一个工作区的 R12
报告、静态截图、fake gateway、临时 SQLite 或文件名相似的实现外推为当前安装版已验证。
自动门禁、冻结 benchmark 和发布制品已经收口；开发期 dirty HEAD 静态视觉 manifest 仅作
`HISTORICAL_ONLY`，不把它写成真实 Tauri 或系统 DPI 证据。

2026-08-21 开始的 `v0.2.6` 真机缺陷修复不倒改本文的 `v0.2.5` 冻结数字、哈希或发布结论。
本地数据库生命周期、AI 建议草稿接受、开书三槽、自动备份和能力验证调用账本的工作树增量见
[`../execution/2026-08-21-V026-REAL-DEVICE-DEFECT-REMEDIATION.md`](../execution/2026-08-21-V026-REAL-DEVICE-DEFECT-REMEDIATION.md)；
截至该历史快照，其最终全量、真机、真实模型、打包与发布均仍为待验证；这不是当前 `v0.2.7` 状态。

## v0.2.5 冻结发布证据

- source fingerprint：`c4260cc189a73c02a53aa0a8eca1b2012b55e77e24bb7ff0e11de5ccf4d27897`
  （1,238 files / 20,794,217 B）。
- artifact fingerprint：`213370d1e2f57dc323203747997071cbee883ffc26cc35339ceec94758f9200d`
  （59 files / 7,035,736 B physical）；bundle policy 7,034,936 / 7,340,032 B，余量 305,096 B。
- 单文件守卫：entry 261,016 / 307,200 B；Agent async 481,776 / 512,000 B；CSS
  128,810 / 131,072 B；worker 1,187,649 / 1,572,864 B。包预算可按可审计需要有界调整，不得无节制放宽。
- 安装包 7,606,152 B，SHA-256
  `f422467fa5fdff4236f3d453cb21de3927c89375e106ff372852f918079f20ad`；manifest 11,717 B，SHA-256
  `4dce031a71eaa1664dcc993bd4f68362fb3d97b7843110b5ebc0b7c45b0bed0c`；`SHA256SUMS` 194 B，SHA-256
  `0f4330efd42cd7d898497de2d0b6866fc2c9ba7b3533e8c11a233dd6a8439eec`。
- RC：Desktop 265 files / 2,049 pass / 1 skip / 0 fail；Rust 169 pass / 1 ignored / 0 fail；
  Chromium 17/17 PASS。Data `0066`–`0070` 对应 Tauri `69`–`73`。

后续文档提交不移动 `v0.2.5` 标签。上述证据关闭自动化发布门禁，不关闭 `BLOCKED_EXTERNAL` 项。

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

历史 `v0.2.4` 于 2026-08-14 公开为 Pre-release。历史 `v0.2.5` 已由上述唯一 commit、annotated
tag、fingerprint、安装包与 Release 固定；两者的证据不可混用。

## 状态定义

| 状态                                    | 本文含义                                           |
| --------------------------------------- | -------------------------------------------------- |
| `CURRENT_REPRODUCED`                    | 当前发布源已重新复现问题，不依赖 R12 结论          |
| `RELEASE_VERIFIED_AUTOMATED`            | 已由 `v0.2.5` 冻结 RC 自动门禁覆盖                 |
| `CURRENT_UNVERIFIED`                    | 当前代码或目标环境尚无足够证据                     |
| `REPORT_*` / `HISTORICAL_ONLY`          | 只属于 R12 或其他历史快照                          |
| `PARTIAL`                               | 有安全、可用的当前切片，但未满足完整能力合同       |
| `DESIGN_ONLY`                           | 只有设计要求，没有当前生产闭环                     |
| `NOT_IMPLEMENTED`                       | 当前代码明确没有该能力                             |
| `DEFERRED` / `DEFERRED_CLOUD_EXECUTION` | 已确认留待后续，不属于当前生产能力                 |
| `BLOCKED_EXTERNAL`                      | 必须依赖真实凭据、目标 Windows、费用授权或外部环境 |

## R12 到 v0.2.5 发布源的映射

| 需求                                             | 当前状态                     | 当前代码入口                                                                                                                                                  | 报告证据                                               | 已有测试                                                                                                                                                                               | 缺口                                                                           | 是否修改                                                                                               |
| ------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 新用户默认直接、升级用户保留原工作方式           | `RELEASE_VERIFIED_AUTOMATED` | `writing-experience-store.ts`、`use-writing-experience.ts`、启动页、设置页、Data `0066` / Tauri `69`                                                          | R12 的直接模式仅是产品建议，不能证明当前实现           | 写作偏好 store、启动页、设置页用例；最终结果 `RELEASE_VERIFIED_AUTOMATED`                                                                                                              | 干净 Windows 首装、真实升级与备份恢复                                          | 是，在同一偏好权威上实现                                                                               |
| 首次启用直接模式的一次性本地整理授权             | `RELEASE_VERIFIED_AUTOMATED` | `direct-mode-authorization-dialog.tsx`、`writing_experience_preferences.direct_local_organization_authorized_at`                                              | R12 建议普通设定静默整理；没有当前授权实现证据         | 授权取消、保存、重开与 CAS 用例；最终结果 `RELEASE_VERIFIED_AUTOMATED`                                                                                                                 | 安装版重启、恢复后只询问一次的人工复测                                         | 是；该授权明确不授予 Provider 调用                                                                     |
| 直接模式续写仍须显式接受 Candidate               | `RELEASE_VERIFIED_AUTOMATED` | `editor-page.tsx`、现有 Candidate/正文提交用例、`direct-writing-disclosure.ts`                                                                                | R12 真实长文属于提交 `6abd16c`，仅作验收输入           | 完整输出先持久化隔离 Candidate；两种模式都需作者选择“使用这版”；接受 append/CAS/旧版本与 0 Provider 用例已接线；最终结果 `RELEASE_VERIFIED_AUTOMATED`                                  | 当前安装版长输出、崩溃边界、撤销和真实账本对账                                 | 是；本地整理授权不再被解释为正文自动接受授权                                                           |
| 专业模式保留 Candidate 决定与高级应用方式        | `RELEASE_VERIFIED_AUTOMATED` | 编辑器 Candidate 比较/接受/拒绝链、设置页写作体验开关                                                                                                         | R12 专业模式页面和长 Candidate 是历史 UI/Provider 证据 | 现有 Candidate 路由、比较、接受/拒绝和版本测试；最终结果 `RELEASE_VERIFIED_AUTOMATED`                                                                                                  | 当前两主题、长文本与真实 Tauri 键盘复测                                        | 在原链上收口，不复制编辑器                                                                             |
| 生成完成后本地整理普通设定                       | `RELEASE_VERIFIED_AUTOMATED` | `direct-story-fact-organizer.ts`、现有 `StoryFactApplicationService`                                                                                          | R12 的云端自动提取不属于当前实现                       | 确定性提取、幂等、过期版本和失败不回滚用例；最终结果 `RELEASE_VERIFIED_AUTOMATED`                                                                                                      | 规则覆盖仍保守；真实作品的误报/漏报需观察                                      | 是；当前实现严格本地、0 Provider                                                                       |
| 重大设定继续拦截确认                             | `RELEASE_VERIFIED_AUTOMATED` | `stageAutomaticFact` 与现有待确认治理链                                                                                                                       | R12 建议死亡、身份、核心关系、世界规则等重大项拦截     | 重大分类、未确认/needs-review 与通知用例；最终结果 `RELEASE_VERIFIED_AUTOMATED`                                                                                                        | 当前规则不是完整语义理解；不得把未识别写成已整理                               | 是；重大项不会自动进入 canon                                                                           |
| Candidate 接受后精确 0 次隐藏云调用              | `RELEASE_VERIFIED_AUTOMATED` | 既有 accepted-version 本地派生管线、Candidate 接受事务                                                                                                        | v0.2.3 隐式云调用是更早历史缺陷；R12 不替代当前证据    | fake gateway 与真实临时 SQLite 已覆盖接受、版本、重启和派生失败；最终全链仍 `RELEASE_VERIFIED_AUTOMATED`                                                                               | 新安装包的 Provider 控制台对账                                                 | 沿用 P0 修复；本轮本地整理仍无 gateway                                                                 |
| 普通 UI 不显示内部错误码                         | `RELEASE_VERIFIED_AUTOMATED` | `ui-error.ts` 及页面集中式投影                                                                                                                                | R12 截图记录两个裸内部码                               | 映射与受影响页面用例；最终结果 `RELEASE_VERIFIED_AUTOMATED`                                                                                                                            | 全页面错误矩阵与真实 WebView 复测                                              | 是，不在页面散落码值拼接                                                                               |
| 长 Candidate 与有效 CSS viewport                 | `RELEASE_VERIFIED_AUTOMATED` | Candidate Dialog、编辑器布局合同、视觉 E2E                                                                                                                    | R12 只证明历史截图的部分长度；主题/视口元数据存在缺陷  | Candidate 共享决策链 7 files / 59 tests PASS；长文本、固定动作区和布局合同已覆盖；最终 Chromium matrix `RELEASE_VERIFIED_AUTOMATED`                                                    | 真实 Windows 系统 200% DPI、50,000 字与两主题人工复测                          | 是；不能用 CSS zoom 冒充系统 DPI                                                                       |
| 深色侧栏、首页/开书底部和正文滚动                | `RELEASE_VERIFIED_AUTOMATED` | `styles.css`、Shell/启动/开书/编辑器布局合同与响应式 E2E                                                                                                      | R12 记录无溢出却显示滚动条、首屏/动作裁切和多层滚动    | 真实 overflow、吸底动作、主内容宽度和窄屏 Drawer 用例；最终结果 `RELEASE_VERIFIED_AUTOMATED`                                                                                           | 浅/深目标矩阵、真实滚动、键盘焦点和系统 200% DPI                               | 是；单文件 CSS 预算守卫保持不变                                                                        |
| SQLite reload 复用单一原生连接                   | `RELEASE_VERIFIED_AUTOMATED` | `native_sqlite.rs`、`tauri-sqlite.ts`、`runtime-context.tsx`                                                                                                  | R12 在另一工作区复现 `SQLITE_ALREADY_OPEN`             | 并发前端 open 合并、session token 轮换、孤立事务回滚与原生 reload 用例；最终结果 `RELEASE_VERIFIED_AUTOMATED`                                                                          | 当前安装版 WebView reload、初始化中 reload 与长期重启                          | 是；不打开空替代库，不覆盖原库                                                                         |
| 手动设定表单打开、预填和焦点返回                 | `RELEASE_VERIFIED_AUTOMATED` | `story-settings-tools.tsx`、设定治理页面                                                                                                                      | R12 在提交 `6abd16c` 的真机路径通过                    | 当前结构化对话框、取消 0 写入/0 Provider 与焦点用例；最终结果 `RELEASE_VERIFIED_AUTOMATED`                                                                                             | 当前安装版键盘、reload 与双 overlay 复测                                       | 复用既有表单，不建平行页                                                                               |
| 统一 `EvidenceRef` 和 `StoryMemoryReadModel`     | `RELEASE_VERIFIED_AUTOMATED` | `packages/ai-core/src/story-memory-read-model.ts`、Desktop 组合读模型、Narrative State                                                                        | R12 的同名类不能外推                                   | L0–L3、current/stale、隐私、分支、未确认/rejected 排除、Narrative 重建和 MemoryRecord 明确提升用例；最终结果 `RELEASE_VERIFIED_AUTOMATED`                                              | 安装版端到端证据下钻与长篇人工质量复测                                         | 是；只读组合现有权威，没有第二事实库                                                                   |
| FTS 始终为检索基线                               | `RELEASE_VERIFIED_AUTOMATED` | `project-search.ts`、多粒度搜索投影与现有索引                                                                                                                 | R12 的 bundle/搜索数字是历史证据                       | 向量、Ollama 或 query embedding 失败时仍返回 FTS；固定六臂本地对照和 production benchmark 已完成，production 默认仍保留简单 FTS                                                        | 可选 vector/graph/rerank 不会自动开启；真实作品人工质量仍为 `BLOCKED_EXTERNAL` | 是；可选能力失败不清空本地命中，也不触发 Provider                                                      |
| 有界本地 query rewrite / multi-query / recovery  | `RELEASE_VERIFIED_AUTOMATED` | `bounded-local-retrieval-query-plan.ts`、consistency tool registry、continuation runtime                                                                      | 新增工程 Prompt 是目标，R12 没有当前实现证据           | 最多 4 条/每条最多 80 字符、确定性去重与兼容字形；续写和调查覆盖 `initial → rewrite → expand_k → evidence_insufficient` 的有界恢复与 content-free trace                                | 已纳入 Desktop/production 发布门禁；不扩大隐私范围、不转远程检索               | 是；纯本地、不能构造 SQL，证据不足时失败关闭                                                           |
| content-free `queryTrace`                        | `RELEASE_VERIFIED_AUTOMATED` | `SearchToolObservation.queryTrace`、`redactedObservationReceipt`                                                                                              | R12 trace 不能外推                                     | 持久 digest 的输入只含来源 ID、类型、方法、结果数和权重，不含 query/正文                                                                                                               | 真实诊断导出与安装版隐私审计尚未跑                                             | 是；本次内存观察可含 query，SQLite 只保存 redacted receipt digest                                      |
| 检索指标与 FTS/rerank 固定对照                   | `RELEASE_VERIFIED_AUTOMATED` | `retrieval-evaluation.ts`、`long-form-retrieval-benchmark.ts`                                                                                                 | 不使用 R12 的 19 条结论充当 benchmark                  | Recall/Precision/MRR/nDCG/hit/authority/stale/rejected/private 指标；六臂本地矩阵及冻结 production SQLite runner 已通过，0 dispatch                                                    | 真人长篇质量判断仍为 `BLOCKED_EXTERNAL`                                        | 是；对照完成不改变默认 FTS，也不冒充真实 Provider 结论                                                 |
| StoryFact→Graph / Narrative / TaskGraph          | `RELEASE_VERIFIED_AUTOMATED` | authoritative StoryFact graph projection、Narrative State read model、consistency TaskGraph                                                                   | R12 的平行实现不能证明当前链路                         | 权威 StoryFact 投影到可重建图；Narrative 从当前接受版本重建；TaskGraph 从同一 run/step/tool/evidence 链只读投影并支持重启重建                                                          | 真人 Tauri restart/restore 下钻仍为 `BLOCKED_EXTERNAL`                         | 是；不建立第二事实源，任一投影失败都不回滚 accepted 正文                                               |
| Production Agent：长篇一致性调查                 | `RELEASE_VERIFIED_AUTOMATED` | 检查页 `ConsistencyInvestigationPanel`、service/store/tool registry、Data `0067`/`0069`、Tauri `70`/`72`                                                      | R12 的 6 次/20 步/19 条结论属于历史 Agent              | 固定只读工具、单次模型、双阶段精确披露、完整 authority fingerprint 双重重检、planned invocation、ledger/task 恢复、迁移与备份已接线；2 files / 36 tests PASS                           | 通用自适应 Agent 明确不在当前合同；真实 Provider/Tauri 为 `BLOCKED_EXTERNAL`   | 是；复用 task、invocation、trace、StoryFact、搜索和 causal graph                                       |
| Agent 根据 Observation 自适应 replan             | `NOT_IMPLEMENTED`            | 当前服务按固定本地工具顺序执行后做一次模型综合                                                                                                                | R12 历史运行不能证明当前实现                           | 无                                                                                                                                                                                     | 若未来实现，必须继续使用固定 allowlist 和每步持久边界                          | 否，当前明确不冒充完整 Agent                                                                           |
| 从调查结果生成修复 Candidate                     | `RELEASE_VERIFIED_AUTOMATED` | `consistency-repair-candidate-service.ts`、`consistency-repair-candidate-recovery.ts`、调查面板、既有 task/Model Hub/trace/output commit/Candidate/版本接受链 | R12 只提出按钮/流程要求                                | 聚焦 fake + SQLite 覆盖确认前 0 call、确认后 1 call/0 retry、精确证据 trace、隔离 Candidate、无效输出、发送后取消 ambiguous，以及 planned/bound/dispatched/迟到成功的重启终结与 0 重发 | 真实 Provider/Tauri、长章质量与人工接受交互仍待第二阶段复测                    | 是；没有第二 Candidate/调用/task/trace store，也不直接改正文；修复 loadout 暂限 L0/L1 精确 EvidenceRef |
| 确认后/dispatch 后 fallback / 多 invocation 收据 | `DEFERRED`                   | 发送前可按已配置 route `use_fallback` 选模；policy 仍固定最多 1 次模型、0 网络重试                                                                            | 增量 Prompt 的未来要求                                 | 最终实际 Provider/model 必须披露并绑定；确认后、not_dispatched、ambiguous 不自动换模或重发                                                                                             | 多次尝试需逐次授权、预算、幂等、独立 invocation 和恢复合同                     | 否；不得把多调用藏入一次调查                                                                           |
| 多粒度 chunk 与 production benchmark runner      | `RELEASE_VERIFIED_AUTOMATED` | Data `0070`、范围化 FTS、production benchmark runner                                                                                                          | 增量 Prompt 是当前实现要求                             | Data 70 files / 432、AI Core 19/129、Search Core 3/34 PASS；六类 chunk、父子定位、范围排除和冻结 production benchmark 48 samples / 2/2 PASS                                            | 云端执行仍延期                                                                 | 是；实现只复用现有本地 SQLite/搜索/调查路径，不引入云端平面                                            |
| `0066`–`0070` 与完整备份恢复                     | `RELEASE_VERIFIED_AUTOMATED` | 五个 forward-only migration、Tauri `69`–`73`、`maintenance.ts`                                                                                                | R12 的同号迁移内容不能充当当前实现证据                 | Data 70 files / 432 tests PASS；70 Data + 3 story-core、planned invocation、0070 范围列、172 表恢复与 ledger/task 对账均覆盖                                                           | 真人安装版旧库升级/恢复仍为 `BLOCKED_EXTERNAL`                                 | 是；没有改写既有 migration/checksum                                                                    |
| 四格式安全图片嵌入与保存回执                     | `RELEASE_VERIFIED_AUTOMATED` | `@inkshadow/import-export`、`browser-pdf-page-rasterizer.ts`、`native_export_artifact.rs`、Data Transfer Panel                                                | R12 没有当前代码证据                                   | import-export 11 files / 90、rasterizer 4/4、save Vitest 16、Rust 5/5、E2E 1/1；内部格式与写后 size+SHA 真实校验                                                                       | 真实 Tauri 保存对话框与四个外部应用打开仍 `BLOCKED_EXTERNAL`                   | 是；浏览器只记 `path_not_available`，不冒充已验证路径                                                  |
| Provider 动作精确披露与隐藏入口关闭              | `RELEASE_VERIFIED_AUTOMATED` | `provider-action-disclosure.ts`、各动作 prepare/confirm 链、普通 UI 错误投影                                                                                  | R12 不能证明当前入口                                   | 续写精确披露 31/31；opening 四类动作 2 files / 79 tests；Settings 55/55；旧导入 Provider 入口关闭且历史 Candidate 显式决定链 5/5；取消/漂移与接受阶段均 0 call                         | 真实 Provider 对账仍 `BLOCKED_EXTERNAL`                                        | 是；旧 route fallback、普通 AI review、新导入生成与普通向量重建保持关闭                                |
| 新静态视觉证据与哈希去重                         | `RELEASE_VERIFIED_AUTOMATED` | `desktop-visual-evidence.spec.ts`、`check-visual-evidence.mjs`                                                                                                | R12 主题颠倒、重复截图、状态失配和视口错误是历史缺陷   | 开发期 32 条 dirty manifest 只作历史支持；发布 Chromium RC 17/17 PASS                                                                                                                  | 真实 Tauri/系统 200% DPI 仍为 `BLOCKED_EXTERNAL`                               | 是；产物继续在 Git ignore 范围                                                                         |
| `Design-temp/` 转为正式设计                      | `DESIGN_ONLY`                | 当前仍是用户未跟踪目录                                                                                                                                        | 不是 R12 代码证据                                      | 无                                                                                                                                                                                     | 本轮明确禁止移动、删除或提交；需后续单独授权和冲突审计                         | 否                                                                                                     |

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

长篇 benchmark runner 已覆盖 5k/20k/50k/200k，并强制绑定唯一冻结 source revision。最终原始
JSON 为 371,204 B，SHA-256
`7b8eef0ed8bd544f23e7efabe74ad09ff187013404730cbec43c7c42d84ec1c5`，48 samples、2/2 PASS；
Recall@K 0.666667、Precision@K 0.597222、MRR/nDCG/hit rate 0.666667、false inclusion
0.069444，authority/stale/rejected/branch/POV/future/private leak 均为 0，evidence/trace
completeness 均为 1，平均 search 3.2295 ms，Provider/network/key/vector calls 均为 0。
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
  普通启动图；发布 Agent async chunk 为 481,776 / 512,000 B；
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

当前有界 Production Agent 合同已实现并进入 v0.2.5 冻结全量复跑；它按固定 allowlist 顺序收集观察后做
一次模型综合与本地验证，不是通用 Tool Call → Observation → 自适应 Replan 循环。自适应 replan
是明确的未来范围，不能用它把当前已完成的有界流程继续标成含糊 `PARTIAL`。发送前允许按已配置 route
的 `use_fallback` 选择并披露实际模型，但仍只有 1 个 invocation、0 网络重试；确认后/dispatch 后
自动 fallback、多 invocation fallback 收据和云端执行仍分别为 `DEFERRED` / `DEFERRED_CLOUD_EXECUTION`。
多粒度 chunk 已实现；production benchmark 已在唯一冻结 commit 上以 48 samples、2/2 PASS 完成，
Provider/network/key/vector calls 均为 0。实际架构与虚线边界见
[`13-LOCAL-AGENT-RAG-ARCHITECTURE.md`](13-LOCAL-AGENT-RAG-ARCHITECTURE.md)。

## Provider 动作披露与关闭入口

当前已完成聚焦审计的续写与 Provider 动作把 prepare 与 dispatch 分开。发送前普通界面显示连接显示名、精确模型、任务、
会发送/不会发送的内容、本地或远程去向、精确最大 Provider 调用数、0 自动重试、费用上限或费用未知，
并将这些权威与当前 connection/catalog/model revision 绑定到 fingerprint。确认缺失或任一权威漂移时在派发前
失败关闭，Provider 调用增量为 0。快速 AI 连接与设置页的固定能力探针也不例外：它们在固定短句生成前显示精确
目标、1 次调用、0 次重试、最多 64 输出 token、可能少量收费，且明确不发送作品正文、灵感、设定或 API Key。
专业/直接续写共用 continuation-generation-disclosure.ts：准备阶段为 0 次调用，确认和 Provider 边界前都复核完整目标、价格、隐私、来源与版本指纹。当前两种模式每次远程发送都逐次披露并取得本次确认；模式偏好和本地整理授权不能复用为远程授权。价格、路由、隐私或源版本漂移均为 0 次派发。
opening 四类动作的聚焦链已 2 files / 79 tests 通过，覆盖二次确认、取消 0-call 和
route/cost/source/privacy 最终复核；Settings 固定能力探针 3 files / 69、图片/编辑器 3 files / 46、
调查/修复 2 files / 36 也已通过。Settings 两个固定文本 probe 最终另以 1 file / 55 tests 通过点击
冻结、fingerprint authority、同一 prepared input 持久化和派发前权威重检；四类漂移 0 call，成功
精确 1 call。豆包 Endpoint ID 非空时作为同一有效模型贯穿披露、保存与派发，Provider dispatch
surface 当前无剩余 P0/P1，并已纳入 `v0.2.5` 冻结 RC。上述自动化合同不能外推为真实 Provider、
网络、账户或费用证明；这些仍为 `BLOCKED_EXTERNAL`。

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
- 当前迁移只向前追加，没有改写已发布 migration 或 checksum。Data `0066`–`0070` / Tauri
  `69`–`73`、真实临时 SQLite 与自动化备份/恢复已纳入发布门禁；真人安装版旧库升级/恢复仍为
  `BLOCKED_EXTERNAL`。

## 验收与发布边界

`v0.2.5` 自动发布门禁已关闭相应代码合同：Desktop 265 files / 2,049 pass / 1 skip / 0 fail，
Rust 169 pass / 1 ignored / 0 fail，Chromium 17/17 PASS。source/artifact fingerprint、安装包与
manifest SHA-256 已在本文“冻结发布证据”中记录。开发期 32 条 dirty Chromium manifest 仅为
`HISTORICAL_ONLY`；其 runtime 是 `static_web_distribution`，不关闭真实 Tauri、系统 200% DPI、
键盘、滚动或外部应用验收。后续文档提交不移动发布标签。

以下项目只能留给独立第二阶段测试：

- 已发布安装包的真人 Windows Tauri/Wry/WebView2；
- 系统 200% DPI、键盘、焦点、Escape、焦点返回和真实滚动；
- Windows Credential Manager、WebView reload、安装/升级/卸载/重装；
- 真实 Provider、直接模式账本对账、长输出、断流/超时/401/429 与 Agent 调查；
- 真实 Tauri 保存对话框与 Markdown/DOCX/PDF/EPUB 在四个独立外部应用中打开；当前结构解析、图片嵌入、
  浏览器下载状态与 Rust 写后回读已有本地自动化，但不替代该外部验收；
- 真实备份恢复和崩溃点恢复。

独立执行说明见
[`../execution/NEXT-UNRELEASED-WINDOWS-TAURI-PHASE-2-PROMPT.md`](../execution/NEXT-UNRELEASED-WINDOWS-TAURI-PHASE-2-PROMPT.md)。
