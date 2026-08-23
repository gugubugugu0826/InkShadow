# 写作体验与长篇一致性调查界面合同

## 2026-08-22 直接模式策略增量

- 直接模式和专业模式的所有正文结果都先保持隔离；每次远程发送逐次披露，作者明确选择“使用这版”后才由接受事务写入正文并创建不可变版本。
- 专业模式仍展示隔离结果，保留比较、接受和放弃，不因直接模式简化而删除能力。
- 方向结果与正文结果使用不同用途；系统方向、自定义方向和换一组均由用户显式动作触发，不自动刷新，也不使用假方向补位。
- 正文保存稳定约一秒后，以已保存版本、持久责任字段和原文证据运行确定性本地设定整理；纯文本用户事实的修改/恢复/合并及所有事实的固定、删除恢复优先。结构化/因果事实不允许通用文本重写或合并。
- 续写远程发送前的额外确认，以及开头生成后的第二次进入正文操作，尚未获得独立授权移除；真实模型也未运行。
- `v0.2.7` 自动化门禁、最终候选、未签名打包和工程预发行已经完成，但不等于真实服务、最终安装程序真机、系统百分之二百缩放或商业发布验收。

> 文档状态：`SUPPORTING_CURRENT`  
> 源码复核：2026-08-23  
> 应用清单版本：`0.2.7`；最新公开版本：[`v0.2.7`](https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.7)（未签名工程预发行）；候选与标签解析提交均为 `cb97876894d6f02c4c901745c95533da7b0260fe`  
> 本轮边界：真实供应商、最终安装程序真机、系统百分之二百缩放与商业门禁仍未完成

本文说明直接模式、专业模式、本地设定整理、StoryMemory 投影和长篇一致性调查在普通界面中的
当前交互。领域内部保留隔离结果、分流、过程记录和后台步骤等精确代码名称；普通用户一级导航
继续只有正文、规划、设定、检查。

发布源由 annotated tag object `51dfd64ba22e9771131f251cdc778ee06f89192d` peel 到 commit
`5b3e212cafde10cd75fa87b7b74bfdfff9347a3d`；source fingerprint 为
`c4260cc189a73c02a53aa0a8eca1b2012b55e77e24bb7ff0e11de5ccf4d27897`（1,238 files /
20,794,217 B），artifact fingerprint 为
`213370d1e2f57dc323203747997071cbee883ffc26cc35339ceec94758f9200d`（59 files /
7,035,736 B physical）。后续文档提交不移动该标签。

## v0.2.6 历史公开工程预发布增量

- 本地数据访问由先进先出、有界队列串行；WebView 重载清理孤儿事务和恢复附件，不能安全清理时
  重开连接。普通错误只给恢复建议，不显示数据库路径、SQL、标识符或内部码。
- 作者选择“使用这版”时，页面只等待正文替换、建议草稿修订比较、新不可变版本和建议草稿终态
  的核心提交；成功后立即刷新正文与版本。搜索、故事关联和设定整理转为后台处理，失败不回滚
  正文，也不会让按钮一直显示仍在接受事务中。
- 固定能力验证也遵守“披露→确认→一次发送→一条模型调用记录”。确认前取消为 0 次，发送后
  无法确认显示“结果待核对”，重启不自动重发。
- 普通界面首句使用“AI 建议草稿”“模型服务”“模型中心”“模型调用记录”；英文领域名只保留在
  专家视图、源码和数据库合同中。

这些实现后来已经随 v0.2.6 公开工程预发布冻结；它们不能作为 v0.2.7 最终候选、真实 Windows Tauri 或真实模型证据。当前状态见
[`../execution/2026-08-22-V027-DIRECT-MODE-REMEDIATION.md`](../execution/2026-08-22-V027-DIRECT-MODE-REMEDIATION.md)。

## 模式选择

| 场景            | 当前行为                                             | 不会发生的事                                |
| --------------- | ---------------------------------------------------- | ------------------------------------------- |
| 全新本地数据    | 初始化为直接模式；首次真正启用前显示一次本地整理说明 | 不读取凭据，不调用 Provider，不修改正文     |
| 旧数据库升级    | 保守初始化为专业模式                                 | 不因升级自动应用任何 AI 内容                |
| 设置 → 写作体验 | 可在直接模式和专业模式之间切换                       | 不改路由、Candidate、任务、正文或不可变版本 |
| 生成进行中切换  | 当前操作冻结启动时的模式，下一次操作使用新模式       | 不让进行中的请求在返回时改变应用策略        |
| 备份恢复        | 恢复权威模式偏好和一次性本地授权                     | 不备份或恢复 API Key 值                     |

普通界面使用“直接模式”“专业模式”低干扰徽标。模式不创建新的编辑器、作品、正文、版本、
Candidate、StoryFact 或账本。

## 首次直接模式授权

首次启用直接模式会打开“启用直接模式前，请确认一次”对话框，说明：

- 完整生成先保存为隔离 Candidate，作者明确选择“使用这版”后才写入正文并创建不可变版本；
- 接受后只在本机整理此次新增 delta 中有明确原文依据的普通设定；
- 整理过程不调用模型、不增加 Provider 次数或费用；
- 每条整理结果保留不可变版本和原文位置；
- 死亡、身份、核心名称、核心关系、世界规则、重大时间线和 POV 等重大设定仍需作者确认；
- 整理失败不会回滚正文和版本；
- 授权保存在本机并随完整备份恢复，以后不重复询问。

取消对话框不会开启直接模式。该授权只有“确定性本地整理”权限，绝不等于云生成或把正文交给
已经在 Model Hub 配置的模型。

## 直接模式续写

直接模式将“继续写”作为主要动作，但生成完成后仍明确说明正文和版本没有改变，要求作者查看并选择
“使用这版”或“放弃”。界面可以简化高级选项，但不隐藏这一正文授权；内部安全链保持完整：

1. 使用实际续写同一套 readiness 和 privacy 预检；
2. 首次使用精确 Provider/model/任务/发送范围/预算组合时披露发送内容、调用数、重试与费用；
3. 完整响应先创建并持久化隔离 Candidate；
4. 等待作者明确选择“使用这版”；一次性本地整理授权不得代替该选择；
5. 核对 Candidate 状态、章节版本和应用锚点，调用现有 Candidate 接受事务，创建新不可变版本并保留旧版本；
6. 接受阶段调用 Provider 的数量必须为 0；
7. 本地整理成功时只提示“已整理 N 条”；有重大项时转入现有待确认治理；
8. 展开详情后才显示 Candidate、版本、Provider/model、调用收据、context trace 和应用位置。

保存过的 Provider 披露 grant 与本地整理授权是两套权限。Provider、精确模型、调用次数、重试
策略、发送范围、费用状态或隐私策略变化时必须重新披露。

没有作者明确接受时，任何结果都不会写正文。partial、truncated、schema invalid、可见文本为空、reasoning-only、
dispatch 后 ambiguous、版本冲突、目标位置失效、整章或跨章改写、大量删除、本地安全校验失败
和应用事务失败也都保持隔离。界面提供查看建议、重新生成或放弃，并明确正文和上一版本没有变化；
ambiguous 不得自动重试。

## 专业模式 Candidate

专业模式继续显示完整控制：

- 生成结果等待作者查看与比较；
- 默认动作收敛为“使用这版”和“放弃”；
- 逐项比较、插入光标、替换选区、整章覆盖、另存副本和编辑 Candidate 放在高级选项；
- Provider/model、预算、context source、trace 与调用收据保持可见；
- 接受使用同一事务并创建新不可变版本；重复接受、旧 revision 或基线冲突失败关闭。

直接模式中的选区替换、整章重写、删除/覆盖已有段落、跨章节移动和合并多个 Candidate 也走此类明确确认，不因模式简化而降低安全门槛。StoryFact 的通用修改、历史恢复和重复合并只适用于 structuredValue = null 的纯文本事实；结构化/因果事实只开放证据查看、固定、删除和删除恢复，结构变化必须使用专用事务。

## 本地普通设定整理

当前整理器只处理作者此次明确接受的新增 delta 中，具有明确句式和位置的普通设定。每条结果写入现有
StoryFact 系统，来源
绑定当前不可变版本、章节、UTF-16 起止位置、原文摘要哈希、隐私与 current/stale 状态。它没有
gateway、credential、route、invocation 或 retry 接口。

普通项自动保存为可追溯、可重建资料，主界面只显示数量；重大项仍保持未确认并在“设定”现有
治理区域拦截。无法明确识别、来源版本已过期、证据重复或整理失败时，系统宁可跳过，也不猜测
写入或影响已接受正文。

## StoryMemory 的普通界面位置

`StoryMemoryReadModel` 只读组合已接受正文、确认 StoryFact、现有叙事状态、ProjectSeed、旧
MemoryRecord 和可重建投影。它不是新的导航，也不在普通界面暴露“GraphRAG”“Embedding”或
“Memory 层”作为一级概念。

当前界面可以依靠它提供带来源的检查/上下文。下列实现已进入 v0.2.5 冻结全量回归：

- L0–L3 与 `EvidenceRef` 已有当前代码合同；
- 未确认、temporary、needsReview、deprecated、rejected Candidate、stale 与其他分支不会成为
  canon；
- FTS 是向量/Ollama 不可用时仍然工作的本地基线；
- Narrative State 是从当前接受版本重建的可派生只读状态；旧 MemoryRecord 只有经作者明确提升才进入 StoryFact canon；
- Data `0070` 的 chapter/scene/event/paragraph/dialogue/story-fact-evidence 多粒度投影在 FTS 排名前按 currentness、
  authority、privacy、branch、POV、story order/time 等范围失败关闭；
- 可选 vector/graph expansion、remote rerank 与云端 Agent 尚未统一到所有任务，界面不得显示“叙事记忆/
  GraphRAG 已全部统一”。

一致性调查当前会在本地把权威事实改写为最多 4 条、每条最多 80 字符的 fact/alias/time/location
查询，再逐条走 FTS。普通界面不展示 query 文本、SQL 或调试 payload；content-free
`queryTrace` 只记录来源 ID、类型、方法、结果数和权重，并仅用于生成持久
`observationDigest`；SQLite 不保存 query、正文或 receipt 本体。FTS 失败会明确终结/降级，不会
因某条本地查询失败直接触发模型派发。
Recall/Precision/MRR/nDCG、authority/stale/rejected/private 等指标只用于离线工程验证，不新增
普通用户“RAG 评分”页面。

## 检查页的长篇一致性调查

入口位于现有“检查”，不会新增 Agent 一级导航。进入页面只展示说明，不调用模型。作者先点
“查看范围与费用”，看到发送前确认：

- 检查章节数和预计输入 token；
- 本机/远程去向、连接显示名、Provider 与精确模型；
- 最大 1 次模型调用、固定 5 个本地只读步骤、0 自动重试和最长等待；
- 费用上限，或“费用未知；提供方可能计费”；
- 会发送与不会发送的资料；
- 私密处理、取消和 ambiguous 规则。

只有“确认并开始 1 次调查”进入派发边界；“不发送并取消”保持 0 次调用。运行过程复用任务中心、
Model Hub invocation、context trace、StoryFact、项目 FTS、causal graph 和既有检查器。
确认 fingerprint 覆盖完整 Model Hub inspection authority、全部 capability evidence、connection display、
隐私、context 与 messages；确认后和最终 dispatch 前都重读。route、价格、目的地、能力、正文或
EvidenceRef 任一漂移都保持 0 Provider 并回到确认界面。内部终态分别记录
`INVESTIGATION_DISCLOSURE_CHANGED` / `REPAIR_DISCLOSURE_CHANGED`，普通用户只看到“本次发送
0 字，请重新查看范围与费用”，不会暴露内部码。

结果区使用中文状态，不在普通界面显示内部码或 raw connection ID。结果可以按严重度、类别和
权威来源筛选；每个 finding 只引用当前已接受正文或已确认设定的精确来源，支持“忽略”和
“标记允许”。partial、失败、未发送、取消和结果不确定分别显示，不能以通用成功覆盖。
同一区域使用现有只读 TaskGraph 投影展示“目标 → 计划 → 行动 → 工具 → 观察 → 核验 →
结果/阻断”的安全摘要；重启只重建展示，不续跑或派发，内部 ID 与失败码不进入普通视图。

当前调查是固定 allowlist 的有界生产切片，状态为 `RELEASE_VERIFIED_AUTOMATED`：它不是通用 Agent，也没有完整
Observation → 自适应 Replan。Agent 不修改正文。已核验 finding 若包含当前章节证据，会按章节提供
“查看修复范围与费用”：准备阶段为 0 次 Provider 调用，另行披露精确 Provider、模型、任务、发送
范围、本机/远程去向、费用、隐私、精确 1 次调用和 0 次重试；作者再次确认后才创建独立 task、Model Hub
invocation、context trace 和隔离 Candidate。模型只返回一处严格校验的连续补丁，本地把它合成为
完整章节 Candidate；finding 的 EvidenceRef 会进入同一 trace，Candidate 与 trace 原子关联。无效
输出、已知失败、取消、结果不明和应用重启都不会自动重发或创建 Candidate；正文/版本漂移会在
发送前与 Candidate 提交前失败关闭。只有作者随后在既有编辑器接受 Candidate，原有 0-call 事务才
会创建新的不可变版本。
调查授权与修复授权彼此独立，不能从第一次调查确认推导第二次发送。当前聚焦回归为 2 files /
36 tests PASS；冻结 Desktop 全量已纳入 `v0.2.5` RC，真实 Provider/Tauri 仍为 `BLOCKED_EXTERNAL`。
修复 task 在既有 `background_tasks.metadata_json` 中只保存 invocation、trace、目标版本和请求
指纹等内容无关的恢复权威。启动恢复只结清状态：未确认的 planned 任务取消，bound 且未发送的
调用结清为 not-dispatched，越过发送边界的取消/中断结清为 ambiguous，已成功但来不及原子提交
Candidate 的迟到结果丢弃；所有分支均为 0 次重发。修复上下文当前只接受 L0/L1 中能与 finding
EvidenceRef 精确匹配的当前权威证据，不会把 FTS 或 causal 的计数收据冒充 Memory Loadout 证据。
发送前可以按已配置 route 的 `use_fallback` 选择实际 fallback，确认页必须披露最终精确
Provider/model；这仍是最多 1 个 invocation、0 网络重试。确认后或 dispatch 后自动 fallback、
多 invocation fallback 收据和云端执行均保持 `DEFERRED`。多粒度 chunk 已接线；5k/20k/50k/200k、
≥30 样本 production benchmark runner 已接线。冻结 commit 的最终 production 结果为 371,204 B，
SHA-256 `7b8eef0ed8bd544f23e7efabe74ad09ff187013404730cbec43c7c42d84ec1c5`，48 samples、
2/2 PASS；Recall@K 0.666667、Precision@K 0.597222、MRR/nDCG/hit rate 0.666667、false
inclusion 0.069444，authority/stale/rejected/branch/POV/future/private leak 均为 0，evidence/trace
completeness 均为 1，平均 search 3.2295 ms，Provider/network/key/vector calls 均为 0。

## Provider 动作的普通界面披露

当前已完成聚焦审计的续写与 Provider 动作都先显示：

- 连接的用户显示名与精确模型；
- 任务名、发送与不发送的范围、本地或远程去向；
- 最多 Provider 调用数、0 自动重试、可核验费用上限或“费用未知”；
- 隐私边界与确认按钮；取消在发送前必须是 0 次 Provider 调用。

确认指纹绑定当前 connection/catalog/model revision 和上述范围；任一目标漂移都回到检查界面，不带旧确认发送。
专业/直接续写共用 continuation-generation-disclosure.ts：准备阶段为 0 次调用，确认和 Provider
边界前重算完整目标、价格、隐私、来源与版本指纹。当前两种模式都逐次展示披露并取得本次明确确认；
模式偏好或一次性本地整理授权都不能代替远程发送授权。价格、路由、隐私、源版本或能力变化后仍为
0 次派发并要求重新确认；附件提出的持久一键授权尚未获独立授权。快速 AI 连接与设置页的固定能力探针同样先显示精确目标、1 次调用、0 次重试、最多 64 输出 token、费用未知，
并明确该固定短句不包含作品正文、灵感、设定或 API Key。连接元数据检查本身不隐式生成文本。
opening 四类动作的聚焦链已 2 files / 79 tests 通过，覆盖二次确认、取消 0-call 和
route/cost/source/privacy 最终复核；Settings 固定能力探针实际收集 3 files / 69 tests 通过，图片生成/
普通编辑器聚焦 3 files / 46 tests、调查/修复 2 files / 36 tests 通过。Settings 两个固定、无作品内容
probe 入口另以 1 file / 55 tests 通过：点击时冻结表单、精确目标与 content-free SHA-256 authority，
持久化同一 prepared input，并在 `gateway.generate` 前复核表单、fingerprint 与权威身份；四类漂移
均为 0 call，成功精确 1 call，发送前阻断与发送后落库冲突分别呈现。豆包 Endpoint ID 非空时
优先作为唯一有效模型，同一值进入普通披露、授权、catalog/connection 保存与最终派发。
冻结全量已纳入 `v0.2.5` RC；真实 Provider 仍为 `BLOCKED_EXTERNAL`，这里的自动化界面合同不能
外推为真实账户、网络或计费结论。

旧 post-dispatch/ambiguous 续写 fallback、普通检查 AI review、导入批处理隐藏 Agent、未授权连续
状态/摘要、translation/short-drama governed dispatch 和普通搜索 vector/rerank 入口均关闭；权威提取
需双特性开关，Multi-Agent 默认关闭且受 guard，rerank 没有 production caller。
普通界面显示“跳过”或可操作的脱敏错误，不显示 raw provider kind、connection ID、绝对路径或内部错误码。
关闭旧导入 Provider 入口不会孤立已保存的隔离 Candidate：作者仍可查看并显式接受、拒绝或恢复原文；
当前聚焦回归 5/5 PASS，接受阶段为 0 Provider 且创建新不可变版本。新的导入试改/逐章生成在完整
精确披露与确认链完成前继续保持关闭。

## 四格式图片导出与保存回执

数据与隐私页的项目导出可在 Markdown、DOCX、EPUB 和 PDF 中真实嵌入安全图片：Markdown 使用 data URI，
DOCX/EPUB 写入 media 与 relationship，PDF 在本地解码并绘制图像页。图片必须是经结构校验的内联 PNG/基线 JPEG，
或由项目显式提供的内存资产；path 只作资产键，导出时不读磁盘或网络。

Tauri 保存成功后，界面显示格式、文件名、绝对路径、字节数和状态。该成功只在原生一次性 ticket、目标身份/竞态检查、
原子写入和磁盘回读 size+SHA 全部成功后成立。取消显示未写入且字节为 0；失败不泄露保存路径。浏览器开发模式只显示
“已发起下载，保存位置无法由应用核验”，不冒充绝对路径已验证。每个项目可在重载后恢复最近一条经严格校验的回执。

真实 Windows Tauri 保存对话框与 Markdown/DOCX/PDF/EPUB 在四个外部应用中实际打开仍为 `BLOCKED_EXTERNAL`，不用结构解析或 Chromium 替代。

## 响应式、键盘与视觉证据

目标宽度仍为 1440、1280、1024、800 和等效 200% 有效 CSS viewport。正文是视觉中心；窄屏把
章节与助手放进可关闭 Drawer，主要动作至少 44px，Dialog 不得超出有效 viewport，页面不得产生
横向 overflow。Dialog、Drawer 和检查筛选需要键盘可达、焦点包含、Escape 和焦点返回。

静态视觉证据脚本已覆盖浅/深主题的首次直接授权、直接模式启动、12,265 字符 Candidate 固定动作
区和检查页，并记录 commit、dirty 状态、Hash route、真实 `data-surface`、CSS viewport、DPR、
时间、字节和 SHA-256；相同 PNG 内容按哈希去重。开发期 dirty HEAD manifest 为 32 条，对应
32 个不同 SHA-256 PNG，保留为 `HISTORICAL_ONLY`。发布 RC 的 Chromium 门禁为 17/17 PASS；两者
都明确是静态 Chromium，检查页没有伪造原生 Agent 已运行状态。

浏览器等效 200% 只能证明有效 CSS viewport 触发响应式布局，DPR2 也不是系统缩放。真实 Windows
系统 200% DPI、Tauri WebView、IME、滚动、hover、键盘和焦点必须按
[`../execution/NEXT-UNRELEASED-WINDOWS-TAURI-PHASE-2-PROMPT.md`](../execution/NEXT-UNRELEASED-WINDOWS-TAURI-PHASE-2-PROMPT.md)
另行复测。

## 当前验证边界

`v0.2.5` RC 已完成 Desktop 265 files / 2,049 pass / 1 skip / 0 fail、Rust 169 pass / 1 ignored /
0 fail 和 Chromium 17/17 PASS。bundle policy 为 7,034,936 / 7,340,032 B，余量 305,096 B；entry
261,016 / 307,200 B、Agent async 481,776 / 512,000 B、CSS 128,810 / 131,072 B、worker
1,187,649 / 1,572,864 B。安装包 7,606,152 B，SHA-256
`f422467fa5fdff4236f3d453cb21de3927c89375e106ff372852f918079f20ad`；manifest 11,717 B，SHA-256
`4dce031a71eaa1664dcc993bd4f68362fb3d97b7843110b5ebc0b7c45b0bed0c`；`SHA256SUMS` 194 B，SHA-256
`0f4330efd42cd7d898497de2d0b6866fc2c9ba7b3533e8c11a233dd6a8439eec`。本文件不以页面存在或局部
用例代替发布证明；真人 Windows Tauri/Wry、真实 Provider、系统 200% DPI 和外部应用打开继续为
`BLOCKED_EXTERNAL`。
