# TencentDB Agent Memory 只读适配审计

> 审计日期：2026-08-20  
> 审计性质：官方仓库只读研究，不引入上游运行时、数据库、Key、路由或后台任务  
> InkShadow 状态：`RESEARCH_VERIFIED / ADAPTATION_SELECTIVE / NO_CODE_IMPORT`

## 固定来源

| 项目        | 已核对事实                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方仓库    | <https://github.com/TencentCloud/TencentDB-Agent-Memory>                                                                                                                                                                                                                                                                                                                                        |
| 默认分支    | `feat/server_team`；远端 `HEAD` 的 symref 于审计时指向该分支                                                                                                                                                                                                                                                                                                                                    |
| 固定提交    | `97f94654280b2932c35ba4806a491999ed244cc9`                                                                                                                                                                                                                                                                                                                                                      |
| `main` 对照 | 审计时 `refs/heads/main` 为 `3f11f6bf67a800a3a00b7d5fba3e3a8acae92ca0`；不是默认分支，不能与默认分支文档混用                                                                                                                                                                                                                                                                                    |
| License     | MIT；以固定提交的 [LICENSE](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/97f94654280b2932c35ba4806a491999ed244cc9/LICENSE) 为准                                                                                                                                                                                                                                                  |
| 主要文档    | 固定提交的 [README](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/97f94654280b2932c35ba4806a491999ed244cc9/README.md)、[README_CN](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/97f94654280b2932c35ba4806a491999ed244cc9/README_CN.md)、[ROADMAP](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/97f94654280b2932c35ba4806a491999ed244cc9/ROADMAP.md) |
| 读取方式    | 对默认分支做 depth-1 临时浅克隆并只读检索源码；临时副本不属于 InkShadow 源码或发布资产                                                                                                                                                                                                                                                                                                          |

上游 README 把记忆分成 L0 Conversation、L1 Atom、L2 Scenario、L3 Core/Persona；高层用于快速恢复工作上下文，细节可下钻到 L1/L0。README 还描述 BM25 + vector + RRF、数量/字符/超时预算，以及 Chat Memory、Skill、Wiki、CodeGraph 作为带来源、版本、状态、可见性和绑定关系的 Memory Asset。ROADMAP 明确路线图不是承诺，并把 L1–L3 人工修正、L0/L1 搜索与 Task 相关会话命令列为继续演进项。

## 源码级事实

本次只记录能在固定提交中定位的实现，不把 README 图或上游声明当作 InkShadow 已实现能力。

| 主题                   | 固定提交中的实现线索                                                                                                                  | 审计判断                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| L0→L3 分层             | `MemoryCore/src/core/record`、`scene`、`persona`；短期工具日志另在 `MemoryCore/src/offload`                                           | 分层和逐级下钻值得借鉴；上游异步 LLM 提取不能直接进入 InkShadow                                                  |
| 原始证据下钻           | `MemoryCore/src/offload/storage.ts` 把完整工具结果放入 `refs/`，Mermaid 节点保留 `node_id`/引用                                       | InkShadow 可复用“高层投影必须能回到 EvidenceRef”的原则；Mermaid 只能是展示，不是权威状态                         |
| BM25 + vector + fusion | `MemoryCore/src/core/hooks/auto-recall.ts`、`core/tools/*-search.ts`、`core/store/search-utils.ts`；SQLite 双路检索以 RRF `k=60` 合并 | 可作为离线对照实验；InkShadow 默认仍以 FTS、硬过滤和确定性融合为基线，vector 只是可选增益                        |
| 检索预算               | `MemoryCore/src/config.ts` 与 `core/hooks/auto-recall.ts` 使用 `maxResults`、每条/总字符上限、`timeoutMs`                             | 采纳显式数量、字符/token 与超时预算；必须有自动化证明运行时真正执行，而不只存在 schema                           |
| 工具日志外置           | `MemoryCore/src/offload` 把完整结果与轻量任务图分开，并处理 tool-use/tool-result 配对                                                 | 采纳“内容有界收据 + 可追溯原证据”；InkShadow 不增加 repo 外 sidecar 文件权威                                     |
| Task/Agent loadout     | `MemoryCore/src/metadata` 的 team/agent/task/asset/binding/ACL；ROADMAP 继续扩展 Task 命令                                            | 只借鉴只读 TaskGraph 投影与 loadout 概念；InkShadow 复用现有 task center/run/step/invocation/trace，不建第二队列 |
| Asset 治理             | `MemoryCore/src/metadata/store/*` 带 `source_ref`、`version`、`status`、`visibility`、ACL；新 Skill 默认 private                      | 采纳来源、版本、状态、权限和显式绑定；小说事实仍只能由当前版本与 confirmed StoryFact 授权                        |
| Skill 生命周期         | `MemoryCore/src/core/skill/types.ts` 有 active/archived、版本、检索模式和两步 proposal 形状                                           | 只映射到 InkShadow 既有 Novel Skill registry/evaluation；单次成功不得自动启用 Skill                              |

## 适配矩阵

| 腾讯做法                               | InkShadow 当前能力                                                         | 适配度  | 复用模块                                               | 最小改造                                                                       | 主要风险                           | 是否实施                        |
| -------------------------------------- | -------------------------------------------------------------------------- | ------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------- |
| L0→L3 逐层压缩并下钻                   | 当前版本、StoryFact、ProjectSeed、StoryMemoryReadModel 与 EvidenceRef 基础 | 高      | current version、StoryFact、Context Compiler           | 补统一 RetrievalScope、NarrativeState 与证据下钻；所有高层结论保留 EvidenceRef | 把模型摘要误升为 canon             | 实施，仍以本地权威重建          |
| BM25 + vector + RRF                    | FTS 基线、可选 vector/graph、检索指标                                      | 中高    | project search、Context Compiler、retrieval evaluation | 先做硬过滤与固定 FTS 基线，再用固定样本比较 RRF/简单融合；收益不足则不启用     | 向量陈旧、无关 top-k、未来知识污染 | 仅实验性实施，不默认依赖 vector |
| 召回数量/字符/token/timeout 预算       | Context Compiler 有 token 预算，Agent/query 有上限                         | 高      | Context Compiler、Context Trace                        | 把每层候选数、字符/token、超时与 omission receipt 纳入同一策略和 trace         | 配置存在但运行时未执行             | 实施并做运行时断言              |
| 完整工具日志外置、轻量任务图入上下文   | invocation/trace/task/finding 已持久化                                     | 高      | task center、Agent run/step、EvidenceRef               | 新增只读 TaskGraph projector，正文/原始 provider 输出不复制到第二存储          | 摘要失真或泄露原始内容             | 实施只读投影                    |
| Memory Asset 来源/版本/状态/权限       | ProjectSeed、StoryFact、Candidate、Skill snapshot 各自有治理               | 高      | 现有实体与 CAS                                         | 统一 read-model DTO，不新建第二事实源                                          | 多 store 对同一事实给出不同结论    | 实施组合读模型                  |
| Agent 固定 loadout                     | Consistency Agent 固定本地只读工具                                         | 高      | 现有五工具白名单                                       | loadout 只引用当前 project/chapter/version/branch/POV/task scope               | 工具越权或把陈旧索引送入模型       | 实施硬过滤与 trace              |
| Skill proposal/版本/评测               | Novel Skill registry + 付费评测账本                                        | 中      | Novel Skill 现有链                                     | 只补失败样本、触发证据和人工批准状态；继续默认关闭                             | 单次成功误启用、额外付费调用       | 有界实施，默认关闭              |
| 自动 L1/L2/L3 后台模型提取             | InkShadow 已关闭接受后的云派生                                             | 低/冲突 | 无                                                     | 不接入；需要时必须另做显式授权、精确模型/费用/调用数与 ambiguous 锁            | 隐式正文上传、重复计费             | 不实施                          |
| sidecar/Memory Hub/第二数据库/第二 Key | InkShadow 已有 SQLite、Model Hub、task center                              | 冲突    | 无                                                     | 不新增                                                                         | 双权威、备份分裂、凭据泄漏         | 不实施                          |
| 自动跨项目 Persona                     | 默认无跨项目画像                                                           | 冲突    | 无                                                     | 若未来需要必须 opt-in、可撤销、来源可见                                        | 跨作品隐私与错误偏好污染           | 本轮延期并保持关闭              |

## 公开问题带来的约束

下列是上游公开 issue 中与 InkShadow 设计直接相关的风险信号；它们不是对固定提交的独立漏洞复现，也不证明 InkShadow 存在同一缺陷。

| 公开 issue                                                                                                    | 对 InkShadow 的约束                                                                              |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [#95：界面关闭但插件仍在后台运行](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/95)           | “关闭”必须真正阻断 dispatch/worker，状态页要解释谁启动了任务；Model Hub 配置不能视为正文处理授权 |
| [#114：自动注入记忆缺少透明度](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/114)             | Context Trace 必须列出采用/舍弃来源，作者能下钻证据，不能隐藏自动注入                            |
| [#106：要求可复现 benchmark](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/106)               | 不采用 README 指标；InkShadow 必须保存固定 fixture、原始结果、commit 与指标定义                  |
| [#155：轮询导致高 CPU/内存](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/155)                | 本地任务采用事件/租约/有界恢复，空闲不轮询，不因重启自动发模型请求                               |
| [#156：双写失配导致记忆不可检索](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/156)           | 不建立 JSONL+SQLite 双权威；索引失败只影响可重建投影，权威正文/StoryFact 不回滚                  |
| [#164：vector 表重建后静默零命中](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/164)          | FTS 必须独立可用；vector 重建要有 generation/revision、restart 与空命中诊断                      |
| [#902：工具搜索未执行相似度阈值](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/902)           | 召回不能只取 top-k；需权威/currentness/branch/POV/time 过滤和“证据不足”终态                      |
| [#672：Proxy/Knowledge 的认证与 SSRF 报告](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/672) | 不引入上游 sidecar、管理端口、Git 抓取器或第二 Key；任何未来外部源都要独立安全审计               |

## Benchmark 边界

固定提交 README 公开的是 PersonaMem `48% → 76%`（相对 `+59%`）一项摘要。该数字属于上游环境、模型、数据与评测协议；本审计没有复现实验，也不将它写入 InkShadow 的产品效果、包体或发布证据。InkShadow 只在自己的固定 5k/20k/50k/200k、多版本/分支/POV/private/rejected/stale fixtures 上记录 Recall@K、Precision@K、MRR、nDCG、权威精度、陈旧/未来/隐私污染率、trace 完整性、延迟、token 与费用，并绑定最终 InkShadow commit。

## 最终取舍

1. 采用：分层读模型、EvidenceRef 下钻、FTS 基线、受预算约束的可选融合、Asset 来源/版本/状态/权限、只读 TaskGraph 与显式 Agent loadout。
2. 改造后采用：vector/RRF、Skill 经验复用、NarrativeState；它们必须经过 InkShadow 现有 SQLite、StoryFact、Context Compiler、Model Hub、task center、Candidate 与备份合同。
3. 明确拒绝：sidecar、第二数据库、第二 API Key、第二模型路由、第二任务队列、第二事实源、隐式后台 LLM、自动跨项目画像、Mermaid 权威、单次成功自动启用 Skill，以及照抄上游 benchmark。
4. 本文只完成研究与取舍，不把任何 `PARTIAL` 能力升格为已验证；具体完成状态继续由 [v0.2.5 Requirement Completion Ledger](14-V025-REQUIREMENT-COMPLETION-LEDGER.md) 和冻结提交测试记录决定。
