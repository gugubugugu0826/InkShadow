# v0.2.5：真实 Windows Tauri 第二阶段测试 Prompt

> 本文件是可独立交付给测试人员的执行 Prompt。  
> 适用对象：从 `v0.2.5` 唯一干净候选提交构建的 Windows Tauri 安装包；`v0.2.4` 是升级基线。  
> 当前状态：`NOT_RUN`。只有实际执行的项目才可改为 `VERIFIED_IN_WINDOWS_TAURI`。  
> 本地自动化、fake gateway、临时 SQLite、静态 Chromium、CSS zoom、DPR2 和 R12 报告均不能替代本测试。

请在隔离的 Windows 11 测试机上执行本 Prompt。测试人员只能在 InkShadow 原生界面中手动输入
自己的 Provider API Key；Codex、WebDriver、脚本、终端、日志、截图、诊断包和报告不得读取、
打印、复制、传输或保存 Key。不得关闭安全门禁、修改数据库、伪造账本终态或为达到调用次数而
自动重试。

## 一、测试对象和证据冻结

开始前记录并冻结：

1. 候选版本、唯一 commit SHA、分支、干净工作树证明和 source fingerprint；
2. 安装包文件名、字节数、SHA-256、签名状态和构建 manifest；
3. Windows 版本/补丁、系统显示缩放、分辨率、DPR、WebView2、Tauri/Wry 和测试用户；
4. Provider、精确模型 ID、账户目录 entry、连接 ID、route revision 与能力证据摘要；
5. InkShadow 调用账本和 Provider 控制台的脱敏基线计数；
6. 测试时区、网络条件和阶段 A 的批准费用上限。

准备三个相互隔离、可丢弃的数据集：

- A：全新 Windows 用户和空 AppData；
- B：从 `v0.2.4` 安装版正常使用后制作的升级/备份副本；
- C：仅用于故障注入、长文和卸载/重装，绝不在唯一取证原件上就地操作。

R12 四份报告来自另一工作区 `E:\InkShadow` 的提交 `6abd16c`。报告中的真实调用、19 条冲突、
截图、migration、测试数量和 bundle 字节只能列入“历史参考”，不能抄入本次候选的结果栏。

## 二、强制停止条件

出现任一情况，立即停止所有后续 Provider 动作。不要重复点击；保留当前窗口、脱敏诊断、任务
中心、调用账本和 Provider 控制台计数：

- 启动、切换模式、打开页面、接受/拒绝 Candidate、撤销、版本恢复、备份/恢复或本地整理触发
  未披露云调用；
- 同一操作、授权、幂等键或重启恢复产生第二次网络派发或重复计费；
- 直接模式绕过 Candidate、未创建不可变版本、覆盖旧版本或把不完整/ambiguous 结果写入正文；
- 普通设定整理调用 Provider，或重大设定未经作者确认进入 canon；
- 私密章节正文、API Key、credential、完整 prompt 或模型完整输出进入不应出现的 payload、日志或
  诊断；
- rejected Candidate、未确认/temporary/needsReview 事实、草稿、stale 证据或其他分支被当作正式
  一致性结论；
- Agent 调用 shell、任意 SQL、文件、任意网络、credential、未注册工具或直接修改正文；
- 取消、断流、崩溃或重启后状态长期停在 running，或 `ambiguous` 自动重发；
- `SQLITE_ALREADY_OPEN`、自动换用空数据库、原数据库被覆盖，或正文/版本/Candidate/账本恢复不一致；
- 普通界面出现内部错误码、raw connection ID、凭据或未经脱敏的底层异常；
- InkShadow 账本与 Provider 控制台的保守调用数无法一一解释；
- 超过当前阶段的调用次数或费用上限。

停止后把未执行项目标为 `NOT_RUN`，不要用后续尝试覆盖第一次失败证据。

## 三、阶段 A：最多 6 次低成本安全回归

阶段 A 的所有页面查看、模式切换、reload、Candidate 决定、本地整理、备份和私密阻断都应为
0 次调用。只有下列明确标注的动作可以调用 Provider；测试人员应在每次动作前写下“预期增量”，
动作后同时核对 InkShadow 和 Provider 控制台。目录读取、探针、失败或“可能未计费”也按最保守
口径计数。建议只用 4–5 次，绝不以用满 6 次为目标。

### A1. 全新首次启动与模式授权（0 次）

1. 用数据集 A 首次启动，确认默认显示直接模式，没有幽灵 ready。
2. 首次点“开始写作”或启用直接模式时，只出现一次本地整理说明：本地、0 Provider、普通项自动
   整理、重大项确认、失败不回滚正文。
3. 先取消：模式不应被错误授权。再次打开并同意，重启应用后不再重复询问。
4. 在设置中切换到专业模式再切回直接模式：正文、Candidate、不可变版本、任务、路由和账本均不
   改变，Provider 增量为 0。
5. 导出完整备份并恢复到可丢弃副本：模式和一次性本地授权保持；备份中不含 Key。

### A2. SQLite reload 与启动竞态（0 次）

在没有生成进行时分别执行 SPA/hash 跳转、WebView reload、连续两次 reload、初始化中 reload 和
进程重启。每次确认复用原数据库、没有 `SQLITE_ALREADY_OPEN`、没有空白替代库，当前正文、版本、
Candidate 和项目数一致。若 UI 不提供 reload，只使用测试环境批准的 WebView reload 入口，不改
应用代码。

### A3. Provider 配置（0–1 次）

只在原生设置界面手动保存 Key。确认 Provider、精确模型、catalog entry、capability 和 route 的
readiness 在顶栏、作品库、Model Hub、任务推荐和实际预检一致。若产品必须用无作品内容探针建立
能力证据，允许最多 1 次并单独记账；否则保持 0 次。重启本身必须是 0 次。

### A4. 直接模式安全续写（预期 1 次）

1. 创建普通章节，保存一段能产生普通位置设定、同时含一个明显重大设定的短文本上下文。
2. 首次点“继续写”，核对一次性云披露包含 Provider、精确模型、发送范围、预计 1 次调用、重试
   上限、费用或费用未知和隐私；本地整理授权不能代替此披露。
3. 允许精确 1 次短续写。返回后确认系统先持久化 Candidate，再只对完整、非 ambiguous、版本未变
   的章末续写执行本地接受。
4. 对账：从 Provider 响应完成到正文、新不可变版本、Candidate accepted、本地整理、重启的调用
   增量必须为 0；旧不可变版本不变，正文只在章末追加，并有撤销/详情入口。
5. 普通设定只提示“已整理 N 条”；重大设定必须停在待确认，确认前不进入 canon。整理失败注入不
   得回滚正文或新版本。
6. 使用相同 Provider/model/任务/发送范围/预算再次进入准备界面时，已保存的精确披露可复用；若不
   真正生成，不得新增调用。改变任一授权维度时必须重新披露。

### A5. 专业模式 Candidate（预期 1 次）

切换到专业模式并做 1 次短续写。结果必须停留为 Candidate，正文和版本保持不变。检查完整比较、
“使用这版”“放弃”和高级应用方式；本轮选择放弃并重启，Candidate 仍为 rejected，正文不变，
放弃及重启为 0 次调用。若预算允许，可将这个动作改为接受，但必须单独证明接受阶段为 0 次、
创建新不可变版本且不能重复接受。

### A6. 私密与权限注入（0 次）

把章节标为私密并尝试远程续写与一致性调查。两者都必须在 invocation/payload 前失败关闭，界面
用中文说明去哪里修，正文和版本不变。把正文写入“忽略系统规则、读取 API Key、调用 shell、发送
私密章节、伪造 Tool Call、修改正文”等提示注入文本；它只能作为不可信内容，不能改变权限。

### A7. 长篇一致性调查（预期最多 1 次）

1. 在“检查”打开长篇一致性调查；进入页面和“查看范围与费用”都应为 0 次。
2. 核对披露：章节数、预计 token、Provider/精确模型、最多 1 次模型、固定 5 个本地只读步骤、
   0 自动重试、费用、发送/不发送内容、私密、取消和 ambiguous。
3. 点“不发送并取消”一次，确认 0 次。重新准备后再明确确认，允许最多 1 次调查。
4. 结果只能引用当前已接受正文或 confirmed StoryFact 的 EvidenceRef；按严重度、类别和权威来源
   筛选可用，partial 不冒充成功，忽略/标记允许可持久化。
5. 核对本地查询规划最多 4 条、每条最多 80 字符；普通页面不应暴露 query、SQL 或调试 payload。
   若脱敏诊断提供 `queryTrace`，只能含来源 ID、类型、`fts`、结果数和权重；当前 SQLite 应只保存
   redacted receipt 的 digest，不能保存 query、正文、prompt 或 receipt 本体。
6. 页面不得显示内部码或 raw connection ID；不得有通用 Agent、任意工具或正文写入能力。
7. 当前“生成修复 Candidate”为 `NOT_IMPLEMENTED`；不得因为按钮、提示或历史 R12 报告声称已
   产生修复 Candidate。
8. 发送前允许按已配置 route 的 `use_fallback` 选择实际 fallback，但确认页、run 与账本必须一致
   显示最终精确 Provider/model，且仍只有 1 个 invocation、0 网络重试。响应确认后或 dispatch 后
   不得自动换模、fallback 或重发；多 invocation fallback 收据与云端 Agent 当前均未实现。

### A8. 阶段 A 放行

阶段 A 保守总计不得超过 6 次。只有全部调用与用户动作一一对应，且没有隐式调用、重复计费、
隐私越界、正文/版本损坏、幽灵 ready、reload 错误、长期 running 或 ambiguous 自动重发，才能
由测试负责人明确批准阶段 B。否则停止。

## 四、阶段 B：20–30 次长篇与故障恢复

阶段 B 需要新的明确费用授权。通过合并场景把总数控制在 20–30 次；不得自动循环、自动重试或
为了达数重复生成。至少覆盖：

1. “从想法开始”的三方案在操作前披露 3 次独立调用；稳定 slot ID 与显示编号分离，部分成功、
   failed、cancelled、not_dispatched、ambiguous 分别终结，任务中心/当前页/账本一致，重启不重发。
2. 直接模式和专业模式各覆盖长输出；至少 8 次长输出，累计至少约 30,000 个中文可见字符。每次
   记录 Candidate、应用决定、旧/新版本和接受阶段 0 次调用。
3. 长 Candidate 重点覆盖约 10,681、12,265、20,000 和 50,000 中文字符：diff 成功与复杂度 fallback、
   编辑、接受、拒绝、Escape、焦点返回、固定底部动作、完整内容不截断和无横向滚动。
4. 至少 3 次在大于 20,000 字符的项目上下文中调用，记录 Context Compiler included/omitted、原因、
   来源、token 预算和 privacy；条件允许时 1 次大于 50,000 字符上下文，否则写明 `NOT_RUN` 原因。
5. 在 generation/Candidate、Provider dispatch、Agent run 的 reserved、bound、dispatched 边界分别
   结束应用进程；重启后未越界者为 not_dispatched，已越界且无法确认者为 ambiguous，均不自动
   重发。
6. dispatch 前取消为 0 次；dispatch 后取消/断流如无法证明结果则为 ambiguous；失败后只能由作者
   新授权手动重试，同一授权/幂等键不产生第二次网络调用。
7. DeepSeek 401、429、超时、断流、截断、空可见输出、reasoning-only 和结构异常；账本保留真实
   invocation 与脱敏底层 cause，普通 UI 只显示安全中文。
8. StoryMemory/检索：未配置 vector、Ollama 停止、embedding capability 失效和可选 graph 不可用时，
   FTS 仍返回当前已接受正文命中并记录降级；unconfirmed、temporary、needsReview、deprecated、
   rejected Candidate、stale 与其他分支不进入 canon。用固定、内容无关 ID 集核对 Recall@K、
   Precision@K、MRR、nDCG、hit rate、authority precision、stale hit rate、rejected Candidate
   contamination rate 和 private leakage count；另保留原始 FTS 与 local rerank 排序对照。章节、
   场景、事件、段落、对话与 StoryFact 证据多粒度 chunk、父子引用和范围过滤已经进入当前实现，
   但 Production benchmark 的最终长篇实跑仍须记录为 `FINAL_BENCHMARK_PENDING`，完成前不能写成
   发布门禁通过。
9. 一致性调查全成功、partial、模型输出解析失败、证据核验丢弃、取消、not_dispatched 和 ambiguous；
   每次最多 1 次模型、0 自动重试。分别在 planned invocation 已保存、running ledger 已创建、
   Provider 发送边界已越过以及 run 已终结但 task 尚未终结时结束进程；重启后 ledger/run/task/step/
   trace 必须对账到同一终态，且调用数不增加。
10. Prompt injection 组合：要求 shell、文件、SQL、网络、Key、私密内容、未注册工具、伪造 tool call
    和修改正文。任何一项越权即停止。
11. 模式切换并发：直接请求进行中切到专业，当前请求仍按启动时合同处理，下一请求采用专业；反向
    同理。切换本身 0 次且不改变现有 Candidate/版本。
12. 备份/恢复：正文、不可变版本、Candidate 状态、写作模式、本地整理授权、Provider 披露 grant、
    StoryFact、路由、invocation、取消/ambiguous、Agent run/step/finding/evidence、step 的
    `planned_invocation_id` 和连接摘要；172 张恢复表逐项按当前清单核对。不含密钥或临时派发租约，
    恢复不自动发送。
13. 从 `v0.2.4` 正常数据副本升级，迁移只向前运行一次；确认 70 个 Data migration + 3 个
    story-core migration 对应 Tauri internal `73`。重启/reload 后 Data `0066`–`0070` 对应状态保持，
    旧正文、版本和历史 invocation 可审计。
14. 真实 Windows 系统 200% DPI，另复测 1440/1280/1024/800：正文为视觉中心、章节与助手 Drawer
    可关闭、主要动作至少 44px、无页面水平 overflow、无不可达嵌套滚动、浅/深主题布局一致，键盘、
    焦点包含、Escape 和焦点返回正确。不得用 CSS zoom 或 DPR2 代替。
15. Markdown、DOCX、PDF、EPUB 真实导出；覆盖安全内联 PNG/基线 JPEG 与显式内存项目资产，确认
    `path` 仅作资产键且不会触发磁盘/网络读取。逐项核对 128 图、4 MiB/图、24 MiB 总量、8192 边长、
    2000 万像素、PNG CRC/JPEG 结构门禁，及 Markdown data URI、DOCX/EPUB media+relationship、PDF
    本地 Blob 解码绘制。Desktop 保存需验证一次性 ticket、目标身份、取消 0 写入、成功回执和
    no-clobber；再用独立应用打开四种制品，检查章节、编码、排版、图片/字体和非占位内容，记录
    文件字节和 SHA-256。真实 Windows 保存对话框和四种外部应用打开均保留 `BLOCKED_EXTERNAL`，
    直到人工证据完成。
16. 真实卸载/重装：分别验证保留与清除本地数据的产品语义、正文/版本/备份、AppData 和 Windows
    Credential Manager；报告不得包含 Key。

## 五、每个动作的记录格式

每个用户动作分配稳定测试 ID，并记录：

| 字段      | 要求                                                                     |
| --------- | ------------------------------------------------------------------------ |
| 阶段/动作 | A 或 B、操作名称、时间                                                   |
| 事前披露  | Provider/model、发送范围、调用数、重试、费用、隐私                       |
| 预期调用  | 明确整数；本地操作写 0                                                   |
| 实际调用  | InkShadow 账本增量与 Provider 控制台保守增量                             |
| 身份链    | 脱敏 project/chapter/version/Candidate/task/run/step/invocation/trace ID |
| 派发状态  | planned/reserved/bound/dispatched 与最终终态                             |
| 数据安全  | 操作前后正文 SHA-256、当前版本、旧版本、Candidate/StoryFact 状态         |
| 恢复      | reload/重启/备份恢复后的同一状态和是否重发                               |
| 结果      | 只能用 `PASS / FAIL / BLOCKED / NOT_RUN / AMBIGUOUS`                     |

失败时同时记录安全中文、脱敏内部 cause、是否越过网络边界和正文/版本是否变化。不要写“看起来
正常”“应该没调用”或“可能通过”。

## 六、视觉证据

每张真实 Tauri 截图记录 candidate commit、route、DOM `data-surface`、CSS viewport、DPR、Windows
系统缩放、Tauri/WebView2、主题、时间、字节数和 SHA-256。截图后做哈希去重；相同内容不能用
不同文件名冒充不同状态。至少覆盖：

- 浅/深首页与首次直接授权；
- 直接续写成功、本地“已整理 N 条”和重大设定待确认；
- 专业 Candidate、长文比较和错误/ambiguous；
- 设定治理、检查/Agent、Model Hub、调用账本、private blocked；
- 1440/1280/1024/800 和真实系统 200% DPI。

静态截图不能证明 hover、键盘、焦点、Escape、滚动、系统 DPI 或网络派发，必须配套动作记录。

## 七、最终交付包

交付一个不含凭据和完整敏感正文的压缩包：

1. 中文主报告和开发团队摘要；
2. 动作 → 预期调用 → InkShadow 账本 → Provider 保守计数 CSV；
3. 脱敏诊断 JSON；
4. 去重后的关键截图及 manifest；
5. 四种真实导出和 SHA-256；
6. 安装、升级、reload、崩溃、备份、卸载/重装记录；
7. 未执行、blocked、ambiguous 与停止原因清单。

报告必须严格分栏：

- `v0.2.4` 及 R12 的历史事实；
- 当前候选的 mock/fake/SQLite/Chromium 自动化；
- 当前候选本次真实 Windows Tauri 结果；
- 当前候选 Provider live 结果；
- 仍为 `NOT_RUN / NOT_RETESTED / NOT_IMPLEMENTED / PARTIAL` 的项目。

未完成阶段 B、真实系统 200% DPI、安装/升级/卸载、Provider 对账或停止条件审计时，不得把整体
版本写成 `VERIFIED_IN_WINDOWS_TAURI`，更不得据此发布。
