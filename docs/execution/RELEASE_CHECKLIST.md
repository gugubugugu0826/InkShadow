# InkShadow 持续发布门禁

> [!IMPORTANT]
> 当前工作树清单已前移至 0.2.9；0.2.8 本地未签名人工复测包继续保留，最新公开版本仍为不可变的 `v0.2.7`。0.2.9 已通过正式构建和原生层最终门禁，尚未完成完整干净提交候选链、推送、标签或发布。

## 0.2.9 真实接口报告修复候选门禁

当前结论：**报告缺陷聚焦回归、数据层和桌面端当前全量、静态检查、开发服务器网页旅程、正式构建及原生层最终门禁已有通过证据；完整干净提交候选链、正式发布版网页端到端、未签名安装包、真实安装和发布仍待执行。** 本节编号对应 v0.2.8 报告，不改写下方历史版本结论；标为“独立安全审计”的项目不是报告新增缺陷。

| 门禁                           | 状态         | 当前证据或剩余边界                                                                                                                                                                       |
| ------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 写作方式                    | 聚焦通过     | 结合现场页面证据与当前源码可稳定复现且与现场现象一致：报告脚本把下拉框按按钮取证，`bs=[]` 不能单独证明永久加载；当前两个模式按钮可操作、状态明确、没有虚假加载占位；不冒充现场唯一根因。 |
| C2 规划路由                    | 聚焦通过     | 结合现场页面证据与当前源码可稳定复现且与现场现象一致：规划必须有经验证的结构化输出；旧版自动路由可安全重算，作者手工路由不变；未取得现场能力和路由快照，不能写成现场唯一根因。           |
| C3 防重复生成                  | 聚焦通过     | 同步围栏覆盖准备、披露与执行；双击不重复准备，确认前零发送，同一轮最多一次派发。                                                                                                         |
| 独立安全审计：确认复核取消竞态 | 聚焦通过     | 关闭操作会使正在等待的确认复核失效；旧异步流程不能清除新操作的忙碌状态，保存待执行期间也不会误记取消；重入回归 3／3。                                                                    |
| B3 本地整理                    | 聚焦通过     | 生产接受路径形成带证据的待确认设定；零条不显示成功假象，并引导一句话添加。                                                                                                               |
| 九万六千零八十八字             | 仅正确性证据 | 内存开发运行时回归通过；真实数据库、Tauri、安装程序耗时和性能门槛未验证。                                                                                                                |
| 独立安全审计：生成失败         | 聚焦通过     | 失败终结旧任务，同一计划不重发；作者重新查看披露后才能建立新请求。                                                                                                                       |
| 独立安全审计：开头失败关闭     | 聚焦通过     | 远程失败不再用确定性本地故事代替；显式本地示例与远程生成保持分离。                                                                                                                       |
| 历史待决定结果                 | 剩余风险     | 报告要求补充过期标记、查看、放弃和保留策略；不得自动删除历史结果，也不得把发布后可再生资源清理当作候选清理。                                                                             |
| 已提供但未读取                 | 证据边界     | 现场 SQLite 与自动备份已随附件提供，但按本轮安全边界未读取；不得写成“未取得”。                                                                                                           |
| 真正未取得材料                 | 证据缺口     | 现场当时的安装包来源提交、未落盘的脱敏诊断包、C1/C3 支持编号、可绑定 C1–C3 的应用日志与调用栈、C2 能力和路由快照、长文接受性能轨迹均未取得；所附两个运行日志为空。                       |
| 报告跳过项                     | 未验证       | 代表试改，以及扩写、润色、缩写独立入口没有被聚焦回归升级为已验证。                                                                                                                       |
| 报告未执行项                   | 未执行       | 断网／超时注入、百分之二百缩放、图片生成和 1280 目标宽度未执行；`Ctrl+K`／`Esc` 仅继承 v0.2.7 历史证据，坏附属记录未在现场库注入。                                                       |
| 验收画布                       | 无效证据     | 画布状态为 `compile-error`，不构成测试通过或产品失败证明。                                                                                                                               |
| 真实外部与安装                 | 未执行       | 未调用付费服务，未读取真实凭据，未执行真实安装、升级、恢复、真实安装性能或人工界面矩阵。                                                                                                 |
| 完整候选与发布                 | 待执行       | 正式构建和原生层最终门禁已通过；完整干净提交候选链、正式发布版网页端到端、敏感信息扫描、打包、唯一提交、推送、标签、Release 和回下载复核均不得由聚焦结果替代。                           |

### 当前候选门禁进度

| 门禁                   | 状态             | 当前证据                                                                                                                                                                  |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据层全量             | 通过             | `pnpm.cmd --filter @inkshadow/data test`：80 个文件、477 项通过、0 项失败、0 项跳过。                                                                                     |
| 桌面端失败链           | 已修复并复跑     | 第一次全量为 280 个文件通过、2 个失败；2,369 项通过、4 项失败、1 项跳过。修复后原失败 4／4、相关 3 个完整文件 134／134 通过。                                             |
| 桌面端当前全量         | 通过             | 第二次 `pnpm.cmd --filter @inkshadow/desktop test`：282 个文件通过；2,373 项通过、0 项失败、1 项跳过。                                                                    |
| 生成重入安全           | 通过             | `pnpm.cmd --filter @inkshadow/desktop test -- src/pages/editor-generation-reentry.test.tsx`：3／3 通过。                                                                  |
| 修复中组合回归         | 通过，非最终门禁 | 12 个文件、332 项通过、0 项失败、0 项跳过；发生在后续两条竞态测试和共同错误码修复之前。                                                                                   |
| 类型、规范、格式与版本 | 通过             | `pnpm.cmd typecheck`、`pnpm.cmd lint`、`pnpm.cmd format:check`、`pnpm.cmd check:desktop-release` 和 `git diff --check` 均通过。                                           |
| 网页开发服务器旅程     | 通过，范围受限   | `pnpm.cmd --filter @inkshadow/web test:e2e`：2 项通过；不是正式 `dist` 或 Tauri 证据。                                                                                    |
| 正式构建               | 通过             | `pnpm.cmd build` 退出码 0；21 个工作区正式构建通过，已生成 Tauri 所需的正式前端 `dist`。                                                                                  |
| 原生层首次顺序证据     | 前置条件停止     | 正式前端 `dist` 尚不存在时单独执行 `pnpm.cmd check:rust`，因 Tauri `frontendDist` 前置条件停止；这不是 Rust 源码诊断通过或失败。                                          |
| 原生层最终门禁         | 通过             | 正式构建后 `pnpm.cmd check:rust` 退出码 0；格式和严格静态检查通过；库测试 194 项通过、0 项失败、1 项忽略（完整 195 项），主程序 0 项、文档测试 0 项；测试阶段 162.92 秒。 |
| 完整发布候选           | 待执行           | 完整干净提交候选链、正式发布版网页端到端、未签名打包、远端持续集成、标签、Release 和回下载复核仍未完成。                                                                  |

在完整候选门禁全部通过前，不创建 `v0.2.9` 发布结论，不填写未知提交、附件、哈希或测试数量。

## 0.2.8 本地人工复测安装包门禁

当前结论：**安装包已生成并完成静态来源核对；完整候选链、真实安装和发布均未执行。**

| 门禁             | 状态   | 当前证据                                                                                                                                                                                                                   |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 应用清单版本     | 通过   | 根清单、桌面清单、Tauri 配置、Rust 清单、Rust 锁定应用包和诊断回退均为 0.2.8；第三方 `libdbus-sys 0.2.7` 未改                                                                                                              |
| 干净唯一来源     | 通过   | 仓库保留清单后验绑定 `5cf76d410652c40eec13fd1a372fd6cacec8b2a6`；这不是测试现场当时取得的提交，现场报告仍准确记录“对应提交未取得”                                                                                          |
| 版本聚焦验证     | 通过   | 正式配置检查通过；Cargo 解析为 0.2.8；诊断测试 5／5；桌面端类型检查通过                                                                                                                                                    |
| 未签名安装程序   | 通过   | `InkShadow_0.2.8_x64-setup.exe`；7,736,030 字节；SHA-256 `c68fee3561abaf4e9972630bb3278a6b53aeda6f48229b69f7aeb05b607b52f0`；内部版本 0.2.8；未签名                                                                        |
| 来源与网页制品   | 通过   | 来源 1,297 个文件、22,346,527 字节、SHA-256 `c125ef56b5ab4d3b1c9767d6d119e6287968e09aab000bff018419bf4bd93037`；网页 59 个文件、7,281,944 字节、SHA-256 `f41106712cada1081d16deeca4edac533e871b169f2b611b347e4dd9b733d047` |
| 完整未签名候选链 | 未执行 | 本轮只改版本来源，为尽快提供人工复测包，没有重复运行 `pnpm release:candidate:unsigned`                                                                                                                                     |
| 真实安装人工矩阵 | 未执行 | 未启动安装程序；安装、升级、卸载、重装、恢复和另一台机器均待用户复测                                                                                                                                                       |
| GitHub 发布      | 未执行 | 未推送主分支、未创建 0.2.8 标签或 Release，v0.2.7 标签与附件不变                                                                                                                                                           |

完整记录见 [`2026-08-24-V028-MANUAL-RETEST-INSTALLER.md`](2026-08-24-V028-MANUAL-RETEST-INSTALLER.md)。

> [!CAUTION]
> `v0.2.7` 已从干净唯一提交 `cb97876894d6f02c4c901745c95533da7b0260fe` 完成候选门禁、
> 远端持续集成、未签名安装程序、带说明标签、公开预发行和三个附件回下载复核。它仍是未签名工程预览，
> 不是商业正式发布。初始提交 `95904b` 的 10／17 和修正提交 `ddd121b` 的桌面端旧节点竞态失败均保留在
> 下方失败链中；`v0.2.6` 及更早记录继续作为不可移动的历史事实。

## v0.2.7 已发布工程预览门禁

当前结论：**未签名 GitHub 工程预发行已完成；真实外部服务与最终安装程序人工矩阵仍未执行。**

| 门禁                   | 状态 | 最终证据                                                                                                                                                                                                                             |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 应用清单版本           | 通过 | 根清单、桌面清单、原生清单、桌面配置和锁文件均为 `0.2.7`                                                                                                                                                                             |
| 直接模式与数据安全     | 通过 | N-NEW1 至 N-NEW5、候选结果隔离、接受后不可变版本、隐私去向快照和失败恢复的自动化与正式浏览器旅程通过；不包含真实供应商调用                                                                                                           |
| 完整未签名候选链       | 通过 | 干净提交前后工作区均清洁；`pnpm release:candidate:unsigned` 退出码 0，`pnpm release:verify:unsigned` 退出码 0                                                                                                                        |
| 全工作区测试           | 通过 | 480 个文件通过、16 个跳过；3,558 项通过、65 项跳过                                                                                                                                                                                   |
| 桌面、数据与网页端     | 通过 | 桌面 271／271 个文件、2,216 项通过、1 项跳过、0 项失败，935.18 秒；数据 73／73 个文件、453／453；网页 4／4 个文件、33／33                                                                                                            |
| 原生层                 | 通过 | 格式、严格静态检查和测试通过；194 项通过、1 项忽略、0 项失败，191.15 秒                                                                                                                                                              |
| 发布版浏览器端到端     | 通过 | 正式网页构建上的 17／17 通过，约 1.7 分钟；生成 40 张唯一视觉证据图                                                                                                                                                                  |
| 干净唯一源码与指纹     | 通过 | `cb97876894d6f02c4c901745c95533da7b0260fe`；1,257 个文件、21,687,616 字节；SHA-256 `5d9bb2ba0ea0e5e715708d4bb9715f9846547d79de20c2fe16577d0db8ee5e95`                                                                                |
| 正式网页制品与环境指纹 | 通过 | 网页制品 59 个文件、7,170,926 字节、SHA-256 `10eb6efcaed652f40f18fe586ad4faacc2c56e6a9427847b66b585c1883ec4c3`；环境 0 个变量、SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`                            |
| Windows 未签名安装程序 | 通过 | `InkShadow_0.2.7_x64-setup.exe`；7,709,375 字节；SHA-256 `6026918e47100360fad564cd17a15070d448ab6b460dfbf5f72467e71a23622b`；产品/文件版本 `0.2.7`；`Authenticode=NotSigned`                                                         |
| 发布清单与校验文件     | 通过 | 清单 11,710 字节、SHA-256 `f1b94f50fb98b24ae634a3d5307c729693d70134946384de923806e511b77685`，`gitCommitSha` 匹配候选；`SHA256SUMS` 194 字节、SHA-256 `fa811ff9962a92e4b247d17407dd2be97c4c4b722888ec4d76a3c3e0c2598b87`，两行均验证 |
| 远端持续集成           | 通过 | [运行 32604363119](https://github.com/gugubugugu0826/InkShadow/actions/runs/32604363119) 绑定最终候选且为成功；云数据库 `97107172455`（1 分 10 秒）、质量 `97107172584`（26 分）、Windows `97107172588`（25 分 2 秒）均成功          |
| 标签与公开预发行       | 通过 | 标签对象 `37a40ddff9ea9aba27549f13f27718e319e2748e` 解析到最终候选；[v0.2.7 预发行](https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.7) 于 `2026-08-22T23:35:10Z` 发布，`draft=false`、`prerelease=true`，恰好三个附件  |
| 公开回下载             | 通过 | 全新目录 `D:\InkShadow\installer\v0.2.7-download-verification-20260822-233551`；三文件大小与摘要完全一致，两行清单通过，清单提交等于标签解析提交                                                                                     |

### 失败链必须保留

- `95904b39a0c2e6c21c30beb0bf02c891dbd798d4` 第一次因缺少匹配浏览器而没有执行 17 项产品断言；
  安装匹配浏览器后从同一干净提交完整重跑为 10／17，7 项失败均被记录，打包按失败关闭。
- `ddd121b517ac32a0aacc5f63a3f1ebca3b457b64` 的候选在桌面端完整测试遇到 1 项设置页旧节点竞态，
  因而在工作区阶段停止；测试最小修正提交 `cb97876` 随后完成整条候选链，未删除断言或放宽全局时限。

### 尚未执行的外部与人工验证

- 真实供应商、真实凭据、真实付费调用和文学质量评估。
- 安装、启动、升级、卸载、重装、迁移和恢复的最终安装程序人工流程。
- 在另一台独立机器上的安装和运行。
- 真实 Windows 系统百分之二百缩放。
- 桌面 WebView 的输入法、权限、磁盘不足、并发和强制结束进程后的恢复。
- 系统保存对话框和外部打开。
- 百万字作品的真实长期压力；现有自动化基准不能替代长期使用验证。
- 代码签名、法律审查、隐私合规审查和正式更新通道。

### 发布后可再生资源清理

清理已经完成：工作区 46 个已解析目标、43,791 个文件、12,344,098,631 字节，Git 跟踪文件为 0，删除后目标残留为 0；Windows 浏览器、测试临时项和过期安装暂存另计 1,890,779,668 字节。源码、文档、设计资料、安装程序、归档和回下载证据均保留。

完整现状见 [2026-08-22-V027-DIRECT-MODE-REMEDIATION.md](2026-08-22-V027-DIRECT-MODE-REMEDIATION.md)。

> [!IMPORTANT]
> `v0.2.6` 已从唯一干净源码 `b744d042eeafdd9db586388d71e701b1d937f366` 完成候选门禁、
> 远端持续集成、未签名安装程序、带说明标签、公开预发布和三个附件回下载复核。D1–D5 聚焦真机
> 结果仍绑定 `722e67e` 的隔离 Windows Tauri 程序，不能外推为正式应用标识安装程序已启动。
> `v0.2.5` 及更早标签和附件继续保持不可移动、不可复用。

> 更新日期：2026-08-22  
> `v0.2.6` 历史发布源码版本：`0.2.6`；该版本当时为最新工程预览  
> 当前结论：**未签名 Windows 工程预发布已完成；真实外部模型和最终安装程序的扩展真机矩阵仍为外部条件阻塞**

> [!WARNING]
> **v0.2.3 发布后安全公告：**提交
> `3abdcfeb327567c632e440d55d11f0af6f4911d2` 的真实 Windows 11 Tauri/Wry +
> DeepSeek `deepseek-v4-flash` 测试发现，接受 AI 建议草稿与不可变版本创建完成后又隐式派发
> `long_memory_compression`，并发送已接受正文。测试已按安全停止条件终止。已发布 `v0.2.3`
> 不建议用于真实模型服务的敏感正文处理。`v0.2.6` 已补充 D1–D5 隔离 Windows Tauri 聚焦复测，
> 但正式应用标识安装程序和真实外部模型没有启动，不能把隔离程序、回环服务或源码自动化写成完整真实平台验收。

v0.2.6 当前区只使用“通过”“未运行”“外部条件阻塞”和“不适用”。历史区保留当时的
状态原文。代码存在不等于发布门禁通过；只有可复核的测试、构建、签名、安装或人工验收证据才能标记通过。

## v0.2.6 已发布工程预览说明与追踪

> 发布：<https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.6>  
> 标题：`墨影 InkShadow v0.2.6 — Windows 真机稳定性修复工程预览版（未签名）`  
> 发布时间：`2026-08-21T15:52:45Z`；不是草稿；预发布标记为真  
> 支持平台：Windows 10 / 11 x64  
> 签名状态：未签名；Windows 可能显示“未知发布者”

| 门禁                   | 状态         | 最终证据                                                                                                                                      |
| ---------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 应用清单版本           | 通过         | 根清单、桌面清单、原生清单、桌面配置和锁文件均为 `0.2.6`                                                                                      |
| D1–D5 隔离真机         | 通过         | 绑定 `722e67e` 的独立 Windows Tauri 程序；D1 重载/重启、D2 原子接受、D3 三槽独立结算、D4 非空恢复、D5 恰好一次能力验证均通过                  |
| 数据保护与迁移         | 通过         | 新增前向迁移 `0071_model_capability_probe_invocation_ledger.sql`，桌面原生内部版本 `74`；172 张表非空备份恢复逐表差异 0；未改已发布迁移或摘要 |
| 凭据命名空间           | 通过         | 隔离程序使用独立标识、数据和凭据命名空间；正式五类凭据、正式数据库和用户目录未读取或修改                                                      |
| 最终干净唯一源码       | 通过         | `b744d042eeafdd9db586388d71e701b1d937f366`；发布清单 `gitCommitSha` 与之完全一致                                                              |
| 全工作区测试           | 通过         | 472 个文件通过、16 个跳过；3,418 项通过、65 项跳过；桌面端 266/2,095+1 跳过，数据层 70/445，网页端 4/33                                       |
| 原生层                 | 通过         | 格式和严格静态检查通过；191 项通过、1 项按外部条件忽略                                                                                        |
| 正式网页与浏览器端到端 | 通过         | 2,286 个模块、58 个文件 / 7,068,735 字节；浏览器端到端 17/17                                                                                  |
| 远端持续集成           | 通过         | 运行 `32497107722`；质量 `96818021976`、Windows `96818022324`、云数据库 `96818022362` 均成功；数据 70/445、维护 50 项、第 73 版恢复 19.873 秒 |
| 来源与网页制品指纹     | 通过         | 源码 1,241 个文件 / 21,134,076 字节 / `3c1d7fb4…bec95`；网页制品 `b746b689…122c4f`；环境 0 个变量 / `e3b0c442…b855`                           |
| Windows 未签名安装程序 | 通过         | `InkShadow_0.2.6_x64-setup.exe`；7,654,178 字节；SHA-256 `c040f7861e3a25d0ca83cde85134ad2c7589e6f08e4a5e643eb8fcbcb3b0dd3a`                   |
| 发布清单与校验文件     | 通过         | 清单 11,522 字节 / `60a34e96…e78a3`；两行校验文件 194 字节 / `bca03c05…a7cea`                                                                 |
| 标签与公开发布         | 通过         | 标签对象 `f17fde56d83688bf6044a47c77794ebf0a46a936` 解析到最终源码；公开页恰有三个附件，发布说明不是附件                                      |
| 公开回下载             | 通过         | 全新目录 `installer/v0.2.6-download-verification-20260822-015245`；三者大小/摘要一致，两行校验通过，下载清单仍绑定最终源码                    |
| 真实外部模型与费用对账 | 外部条件阻塞 | 实际调用 0 次、输入/输出词元 0、费用 0；回环四次均入模型调用记录、尝试均 1、自动重试均 0，但不能替代真实外部模型                              |
| 最终安装程序扩展真机   | 未运行       | 正式应用标识没有启动；D2 主动取消、D4 权限/磁盘/竞争/写入中强停、异机安装/升级/卸载、200% 显示缩放和长期压力未逐项在最终安装程序执行          |

### 失败链必须保留

- `374b3ab` 隔离程序首次启动发生原生主线程栈溢出；`4ffa1ba` 装箱大型异步命令后不再溢出，
  又暴露自动备份回执字段不匹配；`722e67e` 修正字段后 D1–D5 聚焦真机通过。
- 首次远端运行 `32487324853` 因未使用导入和第 73 版恢复 15 秒超时失败；第二次 `32491014038`
  的 Windows 与云数据库已绿，但该恢复用例仍超过 30 秒。
- 调查确认是 Windows 并行同步 SQLite/全迁移资源竞争，不是产品恢复死锁。最终提交只把数据层测试设为
  单工作线程；运行 `32497107722` 三项全绿，没有继续放宽测试时限或修改生产恢复逻辑。

### 公开附件不可变规则

`v0.2.6` 公开页只能保留恰好三个附件：唯一安装程序、发布清单和两行校验文件。发布说明由页面正文提供，
不是第四个附件。不得静默替换、增补同名二进制或移动 `v0.2.6` 标签；发现二进制或迁移问题时使用新的
补丁版本。发布后的文档提交可以推进 `main`，但标签解析和发布清单必须继续固定在最终源码。

完整缺陷时序见
[`2026-08-21-V026-REAL-DEVICE-DEFECT-REMEDIATION.md`](2026-08-21-V026-REAL-DEVICE-DEFECT-REMEDIATION.md)，
精确自动化结果见 [`TEST_RESULTS.md`](TEST_RESULTS.md)。下方 `v0.2.5` 及更早历史按原日期保留。

## v0.2.5 已发布 Pre-release 中文说明与追踪

> Release：<https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.5>  
> 标题：`墨影 InkShadow v0.2.5 — Windows 安全与写作体验工程预览版（未签名）`  
> 发布类型：GitHub Pre-release  
> 支持平台：Windows 10 / 11 x64  
> 签名状态：最终安装包实测 `Authenticode=NotSigned`；Windows 可能显示“未知发布者”

v0.2.5 在已发布 `v0.2.4` 标签基线上收口直接/专业写作模式、本地设定整理、StoryMemory/RAG
基础链路和受控一致性调查，同时继承 Candidate、本地版本与隐私边界。它不是 Beta、GA 或商业
正式版。

### 本次更新

#### 直接/专业写作模式与一次性授权

- 新用户可使用直接模式，既有用户保持专业模式；作者可在设置中切换，偏好使用 revision/CAS 持久化。
- 直接模式首次启用只会一次性说明并授权确定性本地整理，不授权额外联网，也不授权自动接受正文。第一次真实续写会另行披露精确 Provider、模型、任务、发送范围、调用上限、费用状态和隐私边界；任一绑定条件变化时必须重新披露。
- 直接模式和专业模式都先持久化隔离 Candidate；作者明确选择“使用这版”后，才经同一正文替换 fence 在本地接受并创建新不可变版本。
- 配置模型不等于同意后台处理正文；私密章节继续在远程派发前失败关闭。

#### 普通设定自动整理与重大设定确认

- 首次启用直接模式时一并说明并授权本地设定整理；以后仅在作者明确接受 Candidate 后，对此次新增 delta 做确定性本地提取，界面只提示“已整理 N 条”。
- 本地整理精确产生 0 次 Provider 调用，不把正文、Prompt 或凭据写入诊断记录。
- 重大设定不会自动晋升为正式事实，仍进入作者确认；整理失败不会回滚正文或不可变版本。

#### 受控长篇一致性调查

- 在现有“检查”页面提供受控调查，不新增普通用户一级导航；Provider、route、trace 和内部 ID 仍保留为专家/诊断概念。
- 每次调查只使用固定注册的 5 个本地只读工具，作者确认后最多派发 1 次模型调用，自动重试上限为 0。
- 调查结果只持久化有界 EvidenceRef 与 Finding，不直接修改正文；修复 Candidate 使用调查之外的
  第二次独立披露和确认，固定 1 call/0 retry，并通过既有 trace/output commit 保持隔离。
- 两次授权不能互相复用：普通界面分别显示本机/远程、连接显示名、精确模型、发送范围、1 次调用、
  0 自动重试和费用上限或“费用未知；提供方可能计费”。完整 inspection authority、全部 capability
  evidence、connection display、隐私、context/messages 会在确认后和最终 dispatch 前重读；route、
  价格、目的地、能力、正文或证据任一漂移都保持 0 Provider 并要求重新确认。
- reserved/bound/dispatched 边界、取消和重启使用同一持久终态；越过网络边界后无法确认的结果标为 `ambiguous`，绝不自动重发。

#### StoryMemory、RAG 与检索评估

- 接线 L0–L3 StoryMemory 读模型、Narrative State 只读/重建、MemoryRecord 明确提升、现有 FTS/本地 rerank、最多 4 条且每条最多 80 字符的确定性查询规划，以及不含原始正文/查询的 trace 摘要。
- 新增 chapter/scene/event/paragraph/dialogue/story-fact-evidence 多粒度本地投影，父子 UTF-16 定位与 branch/POV/story-time/authority/privacy/currentness 范围在 FTS 排名前失败关闭；Agent 的 FTS-only 入口不触发 embedding 或写入。
- 新增 Recall@K、Precision@K、MRR、nDCG、hit rate、权威命中、陈旧命中、拒绝事实污染和私密泄漏等纯本地评估指标。
- 5k/20k/50k/200k、48 samples 的 production-path benchmark 已绑定最终来源提交运行；2/2 PASS，8.29 秒，原始 JSON 371,204 bytes，SHA-256 `7b8eef0ed8bd544f23e7efabe74ad09ff187013404730cbec43c7c42d84ec1c5`，不拿 fixture 数字冒充。
- 自动多模型 fallback 与确认后动态 replanning 仍保持关闭；调查本身继续遵守 1 次调用、0 次重试，finding 修复则必须重新披露并建立另一个独立 1 次调用。

#### 本地数据、恢复与响应式证据

- 在 `v0.2.4` 基线上只向前追加 Data `0066`–`0070`；70 个 Data migration 与 3 个 story-core
  migration 合并为 Tauri internal `73`，不修改已发布 migration 或 checksum。`0069` 的
  content-free planned invocation 会在账本 INSERT 时原子绑定 step/context trace；启动恢复按发送
  边界结清 ledger/run，并把非终态 task 对账为终态，绝不自动重发。
- `0070` 只为可重建搜索投影追加多粒度类型、父子定位与范围字段；旧行升级为 `legacy_unknown`，在权威源重建前不冒充当前证据。
- 写作偏好、披露 grant 与调查 run/step/finding/evidence 六张权威表进入 172 表备份恢复合同；
  `planned_invocation_id` 随 investigation step 整表恢复，临时派发租约与凭据值仍不恢复。
- SQLite reload 复用原生连接、轮换 renderer session token，并回滚孤立事务；真实 Tauri WebView reload 仍待安装版复测。
- 静态 Chromium 视觉矩阵覆盖浅/深主题、1440/1280/1024/800 与等效 200% CSS viewport；它不是 Windows 系统 200% DPI 或 Tauri WebView 证据。

#### Provider 发送前披露与关闭入口

- 当前可达动作已固定为：编辑器续写/选区改写、故事规划、一致性调查与单条修复 Candidate、图片生成、Model Hub 本地评测、快捷连接/Settings 固定文本 probe、结构化 probe、翻译 probe，以及另行收口的 opening。Candidate 接受、普通正文检查、接受后的本地普通设定整理和本地派生均为 0 Provider。
- 可达动作在发送前显示连接显示名、精确模型、任务、发送/不发送范围、本地/远程去向、精确调用上限、0 自动重试与费用状态；确认 fingerprint 与当前连接/模型/能力漂移时，Provider 调用增量为 0。
- 快速 AI 连接的固定短探针也先显示精确目标、1 次调用、0 次重试、最多 64 个输出 token、费用未知和不发送作品内容；连接元数据检查本身不隐式发起模型生成。
- Settings 两个固定、无作品内容的 probe 入口已完成点击冻结、fingerprint authority、同一 prepared input 持久化和 `gateway.generate` 前的表单/fingerprint/权威身份复核；四类漂移为 0 call，成功精确 1 call。豆包 Endpoint ID 非空时优先作为唯一有效模型，同一值进入普通披露、授权、catalog/connection 保存与派发，双字段不一致不能再确认 A 发送 B；Provider dispatch surface 当前无剩余 P0/P1。
- 旧 post-dispatch/ambiguous 续写 fallback、普通检查页 AI review、导入批处理隐藏 Agent、无授权连续状态/摘要、translation/short-drama governed dispatch 和普通搜索的向量/rerank 入口均保持关闭；权威提取需 `authoritativeExtraction + graphRag` 双开关，Multi-Agent 默认关闭且受 guard，rerank 没有 production caller。缺 route/能力/凭据时显示跳过或失败，不使用伪 Provider 结果。
- 设置 → 写作体验提供“撤销本地整理授权”；该授权只涵盖接受后的本地普通设定整理，不授权联网、接受正文或重大设定。Provider disclosure grant 仍按 fingerprint 失配、同族轮换、active 128、恢复与历史审计合同治理；本轮不要求普通 UI 逐 grant 管理。

#### 四格式图片导出与真实保存回执

- Markdown 使用 data URI，DOCX/EPUB 写入真实 media 与关系，PDF 对本地 Blob 解码后绘制图像页。只接受通过 CRC/结构验证的内联 PNG/基线 JPEG 或由项目显式提供的内存资产；path 只是项目键，不读磁盘或网络。安全上限为 128 图、4 MiB/图、24 MiB 总量、8192 边长和 2000 万像素。
- Tauri 先由原生对话框签发一次性目标 ticket，写入前重验父目录/已选文件身份和竞态，用 no-clobber 原子安装或 `ReplaceFileW`，写后回读字节、大小与 SHA-256。只有此验证成功才返回含 format/fileName/绝对 path/bytes/status 的成功回执；取消为 0 写入，失败不泄露 path。
- 浏览器开发模式只记录 `browser_download / path_not_available`，不冒充保存位置或磁盘回读已验证。真实 Windows Tauri 保存对话框、Markdown/DOCX/PDF/EPUB 由四个独立应用实际打开仍为 `BLOCKED_EXTERNAL`。

#### 前端包体守卫

- 沿用 7 MiB（7,340,032 bytes）前端总预算；入口 300 KiB、异步 chunk 500 KiB、CSS 128 KiB、worker 1,536 KiB、通用资产 2 MiB 的单文件上限不变。
- 该数字是当前门禁，不是永远禁止调整。只有冻结 build 的 source graph 证明实际需要时，才可记录精确新增字节、必要性、替代方案、保留余量与各单文件守卫后做有界修改；不得为通过门禁无节制抬高总量或掩盖单个大文件。
- 调整前必须排除重复模块、测试/HMR/sourcemap、错误静态依赖和可安全拆分的重型模块；总量优先只增加 128/256 KiB，确实无法拆分的单文件才按 32/64 KiB 最小增量调整。同步更新所有守卫并记录调整前后预算、physical dist、policy payload、余量和最大 chunk；不得排除 async 包、改变统计口径或临时关闭检查。
- Agent 重型入口保持延迟加载；没有通过排除异步包、移动测试代码或放宽单文件上限绕过检查。
- 最终冻结 build 为 59 files / 7,035,736 physical bytes；policy payload 7,034,936 / 7,340,032，余量 305,096 bytes；入口 261,016、最大异步 chunk 481,776、CSS 128,810、worker 1,187,649 bytes。总量预算与全部单文件守卫均未调整。

### 当前证据与不得外推的边界

- 本轮未读取真实 API Key，未执行真实 Provider 或付费调用；模型链测试只允许严格 fake/mock。
- 唯一来源提交上的完整候选重新执行 `release:check`、Rust、production Chromium、Tauri/NSIS 和
  provenance；Desktop 为 265 files / 2,049 passed / 1 skipped / 0 failed，600.74 秒；Rust 为
  169 passed / 1 ignored / 0 failed；E2E 为 17/17。精确命令、候选前失败→修复→复跑和逐包数字见
  [`TEST_RESULTS.md`](TEST_RESULTS.md)。
- production benchmark 精确绑定同一 40 位来源提交，48 samples、2/2 PASS；它验证本地检索路径与
  Agent 调用预算，不证明真实 Provider 兼容性、文学质量或付费长篇调用。
- GitHub Actions run `32367317531` 的 Cloud PostgreSQL / forced RLS、Windows native、
  type/lint/test/web build 三项均为 success；job IDs 分别为 `96419578521`、`96419578642`、
  `96419578743`。
- Provider dispatch surface 当前无剩余 P0/P1，但这是 fake/mock 与静态审计结论；真实 Provider、
  Windows Tauri/Wry 人工路径、Credential Manager、系统 200% DPI、升级/卸载和另一台电脑安装均为
  `BLOCKED_EXTERNAL`。
- 真实 Tauri 导出保存对话框与 Markdown/DOCX/PDF/EPUB 外部应用打开均为 `BLOCKED_EXTERNAL`；结构解析、浏览器下载和 Rust 文件写入测试不替代它们。
- 发布为未签名工程预览，不是 Beta、GA 或商业正式版；不得承载敏感正文、唯一数据副本或正式生产任务。

### 已发布追踪

| 属性                     | 最终值                                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 来源 Commit              | `5b3e212cafde10cd75fa87b7b74bfdfff9347a3d`                                                                                                                                                                                         |
| source fingerprint       | 1,238 files / 20,794,217 bytes；SHA-256 `c4260cc189a73c02a53aa0a8eca1b2012b55e77e24bb7ff0e11de5ccf4d27897`                                                                                                                         |
| `v0.2.5` tag             | annotated tag object `51dfd64ba22e9771131f251cdc778ee06f89192d`；peel 精确等于来源 Commit                                                                                                                                          |
| Windows x64 NSIS         | `InkShadow_0.2.5_x64-setup.exe`；7,606,152 bytes；SHA-256 `f422467fa5fdff4236f3d453cb21de3927c89375e106ff372852f918079f20ad`；ProductVersion `0.2.5`；Authenticode `NotSigned`                                                     |
| Release manifest         | `inkshadow-release-manifest.json`；11,717 bytes；SHA-256 `4dce031a71eaa1664dcc993bd4f68362fb3d97b7843110b5ebc0b7c45b0bed0c`                                                                                                        |
| `SHA256SUMS`             | 194 bytes；SHA-256 `0f4330efd42cd7d898497de2d0b6866fc2c9ba7b3533e8c11a233dd6a8439eec`                                                                                                                                              |
| production bundle        | 59 files / 7,035,736 physical bytes；payload 7,034,936 / 7,340,032；入口 261,016、最大 async 481,776、CSS 128,810、worker 1,187,649 bytes；artifact fingerprint `213370d1e2f57dc323203747997071cbee883ffc26cc35339ceec94758f9200d` |
| production benchmark     | 48 samples；2/2 PASS，8.29 秒；JSON 371,204 bytes；SHA-256 `7b8eef0ed8bd544f23e7efabe74ad09ff187013404730cbec43c7c42d84ec1c5`；绑定来源 Commit                                                                                     |
| main CI                  | GitHub Actions run `32367317531`；Cloud PostgreSQL / forced RLS `96419578521`、Windows native `96419578642`、type/lint/test/web build `96419578743` 均 success                                                                     |
| GitHub Release           | <https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.5>；`publishedAt=2026-08-20T12:41:52Z`、`draft=false`、`prerelease=true`；安装包、manifest、`SHA256SUMS` 三个公开附件重新下载后的文件名、字节和 SHA-256 均匹配      |
| Windows Tauri / Provider | `BLOCKED_EXTERNAL`；只能由第二阶段真实测试报告更新，发布动作本身不把它们改成 PASS                                                                                                                                                  |

### 中文 Release notes（已发布）

InkShadow v0.2.5 是一次面向 Windows 桌面端的安全与写作体验工程预览更新。

本次更新加入直接/专业写作模式：首次启用只授权确定性本地整理，不授权额外联网或自动接受正文；
第一次真实续写会另行披露 Provider、精确模型、发送范围、预算、费用状态和隐私边界。生成成功后
仍先形成隔离 Candidate，作者明确选择“使用这版”后才由本地事务接受并创建不可变版本。
普通设定随后只针对新增 delta 在本机整理，界面提示“已整理 N 条”，重大设定继续等待作者确认。配置模型
不代表同意后台发送正文，私密章节继续在远程派发前失败关闭。

“检查”页新增受控长篇一致性调查：固定只读工具、确认后最多 1 次模型调用、0 次自动重试，
取消、崩溃或结果不明确时不会自动重发，也不会直接改写正文。本地 StoryMemory/FTS 查询规划和
检索评估同时补强。已核验 finding 可在单独查看 Provider、模型、范围、费用和隐私后，再确认一次
独立的 1 call/0 retry 修复动作；结果只进入隔离 Candidate，取消、无效输出、结果不明或重启均不
自动重发，接受仍由现有事务创建不可变版本。自动多模型 fallback 与动态 replanning 仍未作为已
完成功能发布。
修复动作只在既有 task metadata 中保存内容无关的 invocation、trace、目标版本和请求指纹；启动
对账只结清 planned/bound/dispatched/迟到成功窗口，不恢复发送权限。发送后取消统一显示结果不明，
晚到内容不创建 Candidate。修复上下文目前只使用 L0/L1 中与 finding 精确匹配的 EvidenceRef，
FTS/causal 计数收据不能冒充权威正文或设定证据。

导出链现在能把经安全校验的 PNG/基线 JPEG 真实嵌入 Markdown、DOCX、EPUB 和图像型 PDF。
Tauri 只在一次性保存票据、原子写入与磁盘回读核验全部成功后显示格式、文件名、绝对路径、
字节和成功状态；浏览器只说明已发起下载且路径不可核验。真实 Windows Tauri 对话框和四个外部应用的
实际打开仍待第二阶段人工验证。

本版本继续保留 Candidate 隔离、本地优先、不可变版本和 forward-only migration，并沿用 7 MiB
总包体预算及既有单文件上限，最终构建没有调整任何预算。安装包、manifest、`SHA256SUMS`、
来源提交、远端 CI、tag 与 Release URL 已按上表绑定并经公开回下载复核。

当前证据来自 fake/mock、真实临时 SQLite、Rust/Tauri 单元集成与静态 Chromium。真实 Provider、
Windows Tauri/Wry 人工流程、Credential Manager、系统 200% DPI、升级/卸载和长篇付费调用仍为
`BLOCKED_EXTERNAL`。本版已按 `Authenticode=NotSigned` 的工程预览发布；
不应承载敏感正文、唯一数据副本或正式生产任务。

## v0.2.4 已发布 Pre-release 中文说明与追踪

> Release：<https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.4>  
> 发布类型：GitHub Pre-release  
> 支持平台：Windows 10 / 11 x64  
> 签名状态：本轮远端元数据审计未重新下载检查 Authenticode，不从历史候选说明推断最终文件签名

v0.2.4 已作为针对 v0.2.3 真实 Windows Tauri 用户测试反馈的安全修复版公开，继续遵守本地优先、
Candidate 隔离和作者最终确认原则。它不是 Beta、GA 或商业正式版。

### 本次更新

#### Candidate 接受保持本地事务

- 接受 Candidate 只保存正式正文、创建新的不可变版本并更新纯本地可重建状态。
- 接受、保存、恢复、worker 重试和历史回填的默认后台链精确产生 0 次 Provider 调用；云摘要、长期记忆、事实抽取和其他正文派生不会因为已经配置模型而自动执行。
- 派生任务失败不会回滚或污染已接受正文；私密章节继续在任何远程派发前失败关闭。

#### Model Hub 连接恢复与统一 readiness

- 删除凭据后可以重新绑定原连接；退役连接保留历史调用审计，但不进入 ready、推荐或普通路由。
- 同一供应商重新配置不要求普通用户手工修改内部 ID；路由始终绑定精确 active connection 与 catalog entry。
- 顶栏、作品库、Model Hub、任务推荐和实际生成共享权威 readiness；当前章节的隐私、上下文或请求预检失败时不会创建 invocation、Candidate 或费用记录。

#### 开书调用终态与重启恢复

- 一批开头建议明确对应 3 次独立 Provider 调用，并在操作前披露可能费用。
- 每个方案使用稳定槽位 ID，分别记录成功、失败、取消、未发送或结果不明确；部分成功不会被通用错误覆盖。
- 应用重启只结清孤立状态，不会自动再次发送已经越过网络边界的请求。

#### 响应式与可访问性

- 200% 等效视口进入正文优先的单列/抽屉布局，修复正文裁切、页面级横向溢出和不可达操作。
- 覆盖 Escape、焦点返回、键盘操作和 44px 主要操作目标。
- production Chromium 的 zoom/DPR2 证据不等于 Windows 系统 200% DPI，后者仍待真实 Tauri 复测。

#### 数据与前端预算

- 只新增 forward-only Data `0065` / Tauri `68`，没有修改任何已发布 migration 或 checksum。
- production 前端总预算调整为 7 MiB；入口、异步 chunk、CSS、worker 和通用资产的单文件上限保持不变。

### 当前自动化证据与边界

- 当前源码记录的完整 `release:check`、Rust/Tauri 原生门禁、真实临时 SQLite 与 production Chromium 均已通过；精确命令和结果见 [`TEST_RESULTS.md`](TEST_RESULTS.md)。
- 本轮没有读取真实 API Key，没有执行真实 Provider 或付费调用。
- `v0.2.4` 已从唯一提交生成标签并公开 Pre-release 与三个附件；来源、字节和 SHA-256 见下表。
- 本轮只读审计复核了远端 Release 元数据和附件摘要，没有重新运行当时的 PR/main CI，也没有回下载附件复算哈希。
- 修复版 Windows Tauri/Wry + Credential Manager 第二阶段复测、真实 DeepSeek 故障矩阵、Windows 系统 200% DPI 和另一台电脑安装仍为 `NOT_RUN / NOT_RETESTED`。

### 已发布追踪

| 属性                   | 已复核事实                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 来源 Commit / tag peel | tag object `9f613572c7f6892ba5aca4700a784c79872457e2`；peel 与来源提交均为 `b74d36ef3342db6813d1d43771bc82c0ed2aa1fb`                   |
| Windows x64 NSIS       | `InkShadow_0.2.4_x64-setup.exe`；7,482,560 bytes；SHA-256 `12ba4382c79f8c7a6bea8a310c21e4f0c0663c5a7e18e9b87729bb1057628c6c`            |
| Authenticode           | 本轮未回下载检查；保持 `NOT_RECHECKED`                                                                                                  |
| Release manifest       | 10,551 bytes；SHA-256 `7e0a8d2cd34c38948fcf880be43c4c44b844cfe4f6df9f7870a290c7ee4016f5`                                                |
| SHA 校验附件           | `SHA256SUMS`；194 bytes；SHA-256 `aaf721500f73cdad58b6d59b8babb9ee9924b16affc16e098b7dfc74d88262f4`                                     |
| PR / main CI           | 本轮未重新查询；保持历史记录，不从 Release 存在反推 CI 结果                                                                             |
| GitHub Release         | <https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.4>；`draft=false`、`prerelease=true`、`publishedAt=2026-08-14T06:19:17Z` |

### 中文 Release notes（v0.2.4 历史发布稿）

InkShadow v0.2.4 修复了 v0.2.3 真实 Windows 用户测试发现的隐式云调用和恢复状态问题：
接受 AI 建议版本现在只执行本地事务，默认产生 0 次 Provider 调用；Model Hub 支持凭据删除后的
重新绑定和明确退役；全局状态与实际生成共享权威 readiness；开书的 3 次独立调用拥有稳定身份、
独立终态和不自动重发的重启恢复；200% 等效视口改为正文优先的单列/抽屉布局。

本版本仍是未签名工程预览。当前修复只有 fake/mock、真实临时 SQLite 与 production Chromium
自动化证据，尚未完成真实 Provider 或修复版 Windows Tauri 第二阶段复测。Chromium zoom/DPR2
不能替代 Windows 系统 200% DPI。在这些复测完成前，请勿将本版本用于敏感正文、唯一数据副本
或正式生产环境。发布时必须补充最终安装包文件名、字节数、SHA-256、manifest、`SHA256SUMS`、
来源提交和实际 CI 结果；任何字段仍为 `NOT_RUN` 时不得发布。

## v0.2.3 已发布 Pre-release 中文说明与追踪

> Release 标题：`墨影 InkShadow v0.2.3 — 未签名工程预览版`  
> 发布类型：GitHub Pre-release  
> 支持平台：Windows 10 / 11 x64  
> 签名状态：未进行 Authenticode 商业签名，Windows 可能显示“未知发布者”

v0.2.3 是一次面向 Model Hub 与正文工作区的工程预览补丁。它继续遵守本地优先、Candidate
隔离和作者最终确认原则，不是 Beta、GA 或商业正式版。

### 本次更新

#### Model Hub 启动与诊断

- 修复跨页面重新进入时 operation 身份重复、页面挂载时间与启动阶段时间混用的问题；诊断现在只统计对应的一次启动流程。
- 系统凭据摘要读取设置 5 秒上限；超时会显示带警告的降级状态、保留已有缓存目录，并隔离迟到结果，不会把超时误报为连接成功。
- 停用、退役或已失效的连接不会被恢复为当前连接。

#### 官方模型候选浏览与连接返回

- 新增默认折叠的官方模型候选浏览器，并为 22 类小说任务提供按供应商与能力整理的发现入口。
- 已连接且具备可信证据的账户目录优先显示；官方候选始终只代表“可发现”，不代表账户已接通、能力已验证或可以直接路由。
- 选择尚未连接的候选只会保存不含密钥的 30 分钟短期连接意图并打开 Model Hub，不会调用模型、保存能力证据或自动修改任务路由。
- 连接后只有账户真实目录出现精确模型 ID 或受控别名，并形成该任务的可信或待探针推荐时，界面才会返回并聚焦原任务；最终能力验证和任务分配仍需作者明确操作。
- 本地 Ollama 只展示本机 `/api/tags` 实际返回的模型，不使用硬编码型号冒充本地目录。

#### 正文工作区与响应式布局

- 修复正文三栏右侧裁切和不可达操作区域。
- 宽屏增加可由鼠标和键盘调整的正文/AI 助手分隔条，并提供 ARIA 语义。
- 1024px 及以下继续使用助手抽屉；修复 800px 紧凑视口下的抽屉高度、滚动和主要操作按钮触达。
- 已在 production Chromium 中覆盖 1536、1440、1280、1024、800，以及 125%、150%、200% 等效视口和代表性明暗主题。

#### Novel Skill 受限冒烟测试

- 使用真实临时 SQLite 验证 Skill 默认关闭、显式启用、重启保留、再次关闭和重启仍关闭。
- 使用一次本地模拟生成验证输出只进入隔离 Candidate；正文与不可变版本不变，拒绝状态和历史 trace 可在重开后保留。
- 全部 Novel Skill 继续标记为实验能力并默认关闭。本轮没有连接网络模型，也没有执行付费评测。

### 本轮源码验证

- Model Hub、连接意图、官方候选目录、正文布局和 Novel Skill 聚焦回归：10 个测试文件，118 项通过。
- Desktop 全量：242 个测试文件，1,793 项通过、1 项跳过、0 项失败。
- Desktop TypeScript、严格 ESLint、Prettier、production build、秘密扫描与差异检查通过。
- Rust 格式、全 target 严格 Clippy 和测试通过：160 项通过、1 项忽略、0 项失败。
- production Chromium 响应式 E2E：6/6 通过。

这些结果证明本次源码在自动化与 Chromium 预览范围内通过门禁，不等于发布制品或以下真实环境已经验证。

### 尚未验证与使用限制

- 未使用真实 DeepSeek 或其他供应商凭据执行目录、文本探针、任务路由或正文生成；不能把官方候选目录视为供应商能力证明。
- 当前代码尚未在打包后的 Windows Tauri WebView 中完成 SQLite + 系统凭据库冷启动、离开/返回、睡眠恢复和超时故障注入。
- 192 次付费 Novel Skill A/B、2,496 项人工评分和真实生成质量评估均未运行；全部实验 Skill 保持默认关闭。
- 尚未在另一台电脑或隔离 Windows 用户中完成首次安装、覆盖升级、卸载、重装和数据保留矩阵。
- 安装包未进行 Authenticode 商业签名。请先备份重要作品，不要把本工程预览用于敏感数据或唯一副本。

### 下载与校验

请只从本仓库的 [v0.2.3 GitHub Release](https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.3) 下载
`v0.2.3` 附件。安装前将安装包与同一 Release 中的 `SHA256SUMS` 对照：

```powershell
Get-FileHash -Algorithm SHA256 ".\InkShadow_0.2.3_x64-setup.exe"
```

Release manifest 用于核对源码提交、源码指纹和前端制品指纹；`SHA256SUMS` 与 GitHub Release 附件元数据用于核对安装包及 manifest 的文件名、大小和 SHA-256。如果任一项不一致，请勿运行。

### 不变的安全原则

- AI 结果先进入隔离 Candidate，只有作者接受后才创建新的不可变正文版本。
- API 密钥只进入系统凭据库，不写入项目数据库、日志或发布附件。
- 私密章节默认不发送给远程模型；读取全书资料的操作在作品仍含私密章节时只允许已验证的本地模型。
- 缺少凭据、路由、能力证据或真实输出时明确失败或跳过，不以模拟结果冒充供应商成功。

### 发布追踪

| 属性                   | 值                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 来源 Commit / tag peel | `3abdcfeb327567c632e440d55d11f0af6f4911d2`                                                                                              |
| 本地候选链             | `PASS`；`CI=true pnpm.cmd release:candidate:unsigned`；1,290.7 秒                                                                       |
| Windows x64 NSIS       | `InkShadow_0.2.3_x64-setup.exe`；7,469,168 bytes；SHA-256 `23413b1bf874e1b25ab77cd156cff75472744c0e73ec830fb83ef98048ea2bb4`            |
| Authenticode           | `NotSigned`                                                                                                                             |
| Release manifest       | `inkshadow-release-manifest.json`；10,167 bytes；SHA-256 `cd047a59e2bbb13e71f4263ba86feffab115cf47d7d9f7b396ab5d2d56111417`             |
| SHA 校验附件           | `SHA256SUMS`；194 bytes；SHA-256 `89ad2c671bdaefa05bb4bbb1d0f6c37cdbbbd4a4e22d53cb7eef95a750def466`                                     |
| PR / main CI           | run `31679607622` 与 run `31681304602`；两轮三项均通过                                                                                  |
| GitHub Release         | <https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.3>；`draft=false`、`prerelease=true`；`publishedAt=2026-08-13T08:45:32Z` |

## v0.2.2 历史发布门禁（不可覆盖）

| 门禁                           | 状态    | 可复核证据或下一步                                                                                                                                                                 |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本与设计基线                 | PASS    | Desktop 与根发布元数据为 `0.2.2`；DESIGN 保持 `v0.3.1b`，不能混写为应用版本；候选链已复核 17 项 release source/config                                                              |
| 开书有限动态计划               | PASS    | 初始 5 个重点、最多 12 个唯一重点；显示 N/M、百分比、剩余重点与扩展原因，不设“三问上限”，也不允许无限追问                                                                          |
| DOCX 导入聚焦回归              | PASS    | `pnpm.cmd --filter @inkshadow/import-export test`：81/81                                                                                                                           |
| Settings 聚焦回归              | PASS    | 设置页完整文件 40/40；高负载四文件组合 76/76；Desktop typecheck 与设置页聚焦 ESLint 同时通过                                                                                       |
| Desktop 全量                   | PASS    | 238 files；1,759 passed / 1 skipped / 0 failed                                                                                                                                     |
| 付费评测 infrastructure        | PASS    | 10 files / 96 tests；仅证明本地派发、账本、盲评和恢复安全，不证明真实付费 A/B 已执行                                                                                               |
| 最终全仓门禁与生产构建         | PASS    | `pnpm.cmd release:check` 退出码 0、1,459.6 秒；3,035 passed / 65 skipped / 0 failed；Vite payload `6,651,786 / 6,717,440` bytes                                                    |
| Rust 严格门禁                  | PASS    | `pnpm.cmd check:rust` 退出码 0；format、严格 Clippy、160 passed / 1 ignored / 0 failed                                                                                             |
| 1440/1280/1024/800 与 200% E2E | PASS    | production `dist` 的 Chromium 规格 11/11；尚不是 Tauri WebView                                                                                                                     |
| 备份恢复表覆盖                 | PASS    | 166 张作者数据表进入恢复合同；内容无关的原生项目派发 lease 明确不恢复                                                                                                              |
| 真实 DeepSeek Key 互操作       | NOT_RUN | 没有读取或使用真实 Key；本地/模拟测试不能标记供应商 `VERIFIED`                                                                                                                     |
| 干净唯一提交与来源指纹         | PASS    | 提交 `7dd746e7b35d07f9ae9605738d16dd852fd513a4`；PR #2 merged exact SHA；源码指纹 SHA-256 `f6eea0d621dde929775a878319baf351c361cd05ca257ad8a9e11096468f2ddd`                       |
| 未签名 NSIS、大小与 SHA-256    | PASS    | `InkShadow_0.2.2_x64-setup.exe`；7,458,168 bytes；SHA-256 `3048198c44bcb79ad240642ce81e698d499bfbf0bf443a62099d0a57ac5c128c`；`NotSigned`                                          |
| PR 与 `main` GitHub Actions    | PASS    | PR run `31500721439` 与 main run `31502928893` 的 quality、Windows native shell、Cloud PostgreSQL 均通过                                                                           |
| GitHub `v0.2.2` Pre-release    | PASS    | tag object `706b7d211f651e2a5eabdd738a79b93ff5ce10f0` 指向发布提交；Release 为 `draft=false`、`prerelease=true`：<https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.2> |
| Authenticode 商业签名与时间戳  | BLOCKED | 缺少获授权的 Windows 发布主体、代码签名证书和正式时间戳服务；因此 `v0.2.2` 仅作为未签名工程预览 Pre-release 发布                                                                   |

## v0.2.2 已发布 Pre-release 说明与追踪

> 发布状态：`PUBLISHED / PRE_RELEASE`。以下内容和追踪数据绑定提交 `7dd746e7b35d07f9ae9605738d16dd852fd513a4` 与公开 Release；附件不得静默替换。

### InkShadow 墨影 v0.2.2（未签名工程预览）

本补丁继续收口从想法开书、Model Hub、设定维护和正文工作区的可用性与安全边界：

- 开书引导使用有限动态问题计划：初始 5 个重点，最多 12 个唯一重点，并显示 N/M、完成百分比、剩余重点和扩展原因；作者可随时返回、跳过或结束；
- AI 开头、续写、改写和设定建议继续先进入隔离建议版本；作者接受前不覆盖正式正文或重大正式设定；
- 完善模型连接、能力证据、小说任务分工、生成前检查与可理解的失败恢复；缺少凭据、路由或能力时明确失败或跳过；
- 增加默认关闭的 7 个 Core 与 5 个 Genre Novel Skill 实验能力；只有作者显式启用时才进入生成，并为每次开书或续写保留精确 Skill snapshot 与采用/舍弃回执；
- 增加截断、取消和继续补全流程；任何不完整输出仍只保存为隔离 Candidate，不覆盖正文；
- 增加内容无关的 Novel Skill 付费评测基础设施；准备、报价、授权和恢复均不会调用模型，只有作者另行点击“手动开始 192 次付费调用”才可能产生真实请求和费用；
- 完善 Story Settings 严格导入、冲突处理、收据恢复、撤销与旧开书设定整理；
- 调整正文三栏在窄窗口与高缩放下的抽屉/滚动行为，并收口 DOCX 安全导入路径。

发布限制：

- 本版本已作为 GitHub `Pre-release` 的未签名工程预览发布，不是 Beta、GA 或商业正式版；Windows 可能提示“未知发布者”；
- 本轮没有使用真实 DeepSeek API Key 完成线上目录、文本探针、任务路由和正文生成验收，不能宣称真实 DeepSeek 供应商已验证；
- 请先备份重要作品，不要把工程预览用于敏感数据或唯一副本；商业签名和隔离 Windows 安装/升级/卸载矩阵仍未完成；
- `v0.2.0`、`v0.2.1`、`v0.2.2` 及其标签、附件与哈希均保持不可变；后续修复必须使用新的补丁版本。

发布追踪：

| 属性                      | 值                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 来源 Commit SHA           | `7dd746e7b35d07f9ae9605738d16dd852fd513a4`                                                                                     |
| Annotated tag object      | `706b7d211f651e2a5eabdd738a79b93ff5ce10f0`                                                                                     |
| 源码指纹                  | 1,143 files / 18,948,527 bytes；SHA-256 `f6eea0d621dde929775a878319baf351c361cd05ca257ad8a9e11096468f2ddd`                     |
| 本地候选链                | `PASS`；1,303.3 秒；本地候选安装包 7,457,530 bytes，SHA-256 `4157bcd289522533eefee970aabc533eb4907d48cc57d97d8f5ef464fce7bfe5` |
| Windows x64 NSIS          | `InkShadow_0.2.2_x64-setup.exe`；7,458,168 bytes；SHA-256 `3048198c44bcb79ad240642ce81e698d499bfbf0bf443a62099d0a57ac5c128c`   |
| Authenticode              | `NotSigned`                                                                                                                    |
| Release manifest          | `inkshadow-release-manifest.json`；9,989 bytes；SHA-256 `49752eb2cce9a4f73054d946605f25a25d64968e00f7aff64945d19b0a673f01`     |
| SHA 校验附件              | `SHA256SUMS`；194 bytes；SHA-256 `4aa1ce2b2bfd8e4268b3b815b9741da830a5775170fcd33beac44c1bea67bb80`                            |
| PR / main CI              | run `31500721439`：22m38s / 22m41s / 1m03s；run `31502928893`：21m16s / 22m32s / 56s；两轮三项均通过                           |
| GitHub Release URL 与状态 | <https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.2>；`draft=false`、`prerelease=true`                            |

## v0.2.1 已发布历史 Pre-release（不可覆盖）

| 门禁       | 状态 | 可复核证据                                                                                                                   |
| ---------- | ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| GitHub     | PASS | 公开未签名 Pre-release：<https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.1>；Release ID `367562352`            |
| 标签与提交 | PASS | 既有 tag object `3f13c7d` 指向提交 `fa2b567`（`main`）；不得移动、覆盖或复用 `v0.2.1` 标签                                   |
| 历史附件   | PASS | 已包含当时的 installer、manifest 与 SHA 校验附件；只绑定历史提交，不得代替 v0.2.2 的候选、哈希、Tauri WebView 或异机安装证据 |

## v0.2.0 历史最终候选链路

| 门禁                         | 状态    | 可复核证据                                                                                                               |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| v0.2.0 干净提交候选链路      | PASS    | `435454b952bead1014dd7d44f0f4806d70fce7e5`；本地 703.9 秒完整通过，源码指纹与内嵌发布清单一致。                          |
| 格式、秘密、许可证与架构边界 | PASS    | Prettier、秘密扫描、151 项运行时依赖许可证、20 包边界、17 项发布脚本测试与 production 配置门禁通过。                     |
| 全仓 TypeScript 与 ESLint    | PASS    | 20 个 TypeScript 工作区与全仓零警告 ESLint 通过。                                                                        |
| 自动化测试                   | PASS    | Workspace `2,569 passed / 65 skipped`；Desktop `1,420 passed / 1 skipped`；Rust `147 passed / 1 ignored`。               |
| 全工作区生产构建             | PASS    | 所有可构建工作区通过；公开桌面前端 82 文件 / 6,325,162 bytes，团队功能双开 87 文件 / 6,412,787 bytes，均低于既有总预算。 |
| Desktop 生产 E2E             | PASS    | 当前生产与正式候选 `dist-release` 均通过；完整候选链记录 `9/9`，另有 DPR2 焦点稳定性 `10/10`。                           |
| 未签名 NSIS 生成             | PASS    | 7,429,121 bytes；SHA-256 `6E824533BE5FBBBC2693C8F3891BA2CDD5850B39BA17674C8D1A4EF3E1D2FC20`；已归档并公开上传。          |
| GitHub Actions 与附件回读    | PASS    | run `31289865897` 三作业成功；Release 三附件重新下载后的大小与 SHA-256 均一致。                                          |
| 最新候选安装/启动/卸载 smoke | NOT_RUN | 未运行最新候选的安装、首次启动、覆盖升级、卸载和重装；旧候选的历史 smoke 不能替代本次验证。                              |
| Authenticode 签名与时间戳    | BLOCKED | 缺少获授权的 Windows 发布主体、代码签名证书和正式时间戳服务。                                                            |

## 2026-08-08 15:04 历史产品重构候选

| 属性           | 值                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 归档安装包     | `archive/2026-08-08-v0.2.0-product-rebuild-candidate/artifacts/墨影 InkShadow_0.2.0_x64-setup.exe`                             |
| 独立安装器     | `installer/v0.2.0-product-rebuild/墨影 InkShadow_0.2.0_x64-setup.exe`                                                          |
| 生成时间       | `2026-08-08 15:04:08 +10:00`                                                                                                   |
| 大小           | `7,404,796 bytes`                                                                                                              |
| SHA-256        | `99D8EB731F6DF16F5DAEA05BB7AC9D640D1498B19853F45776CD30A1BB36912A`                                                             |
| 版本           | ProductVersion / FileVersion `0.2.0`                                                                                           |
| Authenticode   | `NotSigned`                                                                                                                    |
| 原生程序       | `25,018,368 bytes`；SHA-256 `3AF505EEE8B49B87C01B5249B72F77CAFC55916F1C1F53A6DB0DC9D308072B84`；PE Subsystem `Windows GUI (2)` |
| 源输入指纹     | 818 文件 / 12,916,755 bytes；SHA-256 `0ad7dfd95176cf93bf25ed8772375c362bf88cabf718629adb334e862586b0ca`                        |
| 前端制品指纹   | 83 文件 / 6,239,149 bytes；SHA-256 `a2c19794f4230f09d126774b4e2e97f81f73bd8807febe956da2a48fed4a2e13`                          |
| 复制复核       | 归档时构建目录、安装器目录与归档安装包摘要一致；原生程序复制前后摘要一致。构建缓存随后已清理，当前以归档件复核                 |
| 最新候选 smoke | `NOT_RUN`：尚未执行隔离 Windows 用户的交互安装、首次启动、覆盖升级、卸载和重装矩阵                                             |
| 工作区清理     | 已清理 13.062 GiB 的可再生成 Rust/Tauri 构建缓存；旧临时证据与 Playwright 报告已移入候选归档，未强制删除                       |

## 2026-08-08 09:00 历史候选产物

| 属性           | 值                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 文件           | 原生成路径为 `apps/desktop/src-tauri/target/release/bundle/nsis/墨影 InkShadow_0.2.0_x64-setup.exe`；构建缓存现已清理        |
| 生成时间       | `2026-08-08 09:00:16 +10:00`                                                                                                 |
| 大小           | `7,333,212 bytes`                                                                                                            |
| SHA-256        | `4425B8E7B5E18B76B63E93481D3CA2D1251FF873990545DFB753672B8DC6571B`                                                           |
| 版本           | ProductVersion / FileVersion `0.2.0`                                                                                         |
| Authenticode   | `NotSigned`                                                                                                                  |
| 源输入指纹     | 799 文件 / 12,195,475 bytes；SHA-256 `1ded2bb88ab757c87a8e641166ecc04762edc2521d4714cb2e39f2c21b15375a`                      |
| 前端制品指纹   | 81 文件 / 6,284,151 bytes；SHA-256 `abb51e4fbafe3ad5b21cb139b356b599f7994909c4da1e5a59c0e2490f16f8d7`                        |
| 发布清单       | 15,512 bytes；不计入 6 MiB 有效载荷预算，受独立 32 KiB 上限约束                                                              |
| 原生程序       | 24,635,392 bytes；SHA-256 `E91B57BE79769594F884E35981FB97FEDE6A1ED2CDF08B50896C0BC91D42DAC7`；PE Subsystem `Windows GUI (2)` |
| 最新候选 smoke | `NOT_RUN`                                                                                                                    |

该哈希仅标识 2026-08-08 09:00 的历史未签名内部候选，不对应当前工作树；签名、重打包或任何字节变化后必须重新记录大小、时间和 SHA-256。

## 2026-08-08 历史自动化能力门禁

本节以及随后两个产品范围表冻结 2026-08-08 当时的工程证据；其中 `PASS` 不代表
当前 `0.2.2` 工作树。历史 `v0.2.0` 候选状态只以上方“v0.2.0 历史最终候选链路”的
精确发布提交和证据为准，也不能替代当前门禁。

| 范围                    | 状态 | 证据或限制                                                                                                  |
| ----------------------- | ---- | ----------------------------------------------------------------------------------------------------------- |
| Desktop 单元、集成与 UI | PASS | 当时 `199` 个文件、`1,282` 项通过、`1` 项真实 Ollama 条件跳过。                                             |
| Cloud 默认运行          | PASS | `21` 个文件通过、`16` 个文件跳过；`87` 项通过、`64` 项跳过。跳过项需要 PostgreSQL。                         |
| Cloud 真实 PostgreSQL   | PASS | 角色分离后的全新库全套为 `37` 文件/`151` 项；最终 FORCE-RLS 加固另以真实库定向 `1/1` 覆盖两类漂移。         |
| Workspace packages      | PASS | 当时工作区合计 `2,379` 项通过、`65` 项按 PostgreSQL/Ollama 外部条件跳过。                                   |
| Web Guest               | PASS | `33` 项通过；不外推为完整 Web Cloud 产品。                                                                  |
| Rust 原生层             | PASS | `cargo fmt --check`、严格 `clippy -D warnings` 通过；`146` 项通过、`1` 项真实 Ollama 条件忽略。             |
| 历史迁移兼容            | PASS | 已发布 v4 SHA-384 固定回归通过；用户数据库 v1–v11 与当时源码全部匹配。                                      |
| Android JVM 层          | PASS | `24/24`；不等于 Android SDK、instrumentation 或真机 KeyStore 验证。                                         |
| Enterprise 脚本         | PASS | 部署、支持与恢复门禁 `8/8`。                                                                                |
| 安全更新器              | PASS | Rust `7/7`、UI `3/3`、Node 发布套件 `9/9`。                                                                 |
| Marketplace             | PASS | Desktop 定向回归 `10/10`。                                                                                  |
| 备份与恢复              | PASS | 135 张可恢复权威表、1 张不恢复租约表、4 个恢复后重建的派生根表及失败回滚已纳入当时 Data/Desktop/Rust 门禁。 |

## 2026-08-08 历史 Community Windows 边界

| 门禁                            | 状态        | 证据或缺口                                                                                |
| ------------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| 无登录本地启动与本地数据所有权  | PASS        | 本地项目、章节、版本、稳定正文和恢复草稿均有自动化覆盖。                                  |
| AI Candidate 不静默覆盖正文     | PASS        | 生成结果隔离；只有显式接受才写入正式版本。                                                |
| AI 预检、预算、取消、重试与幂等 | PASS        | Desktop、Data、Rust 分层回归通过。                                                        |
| SQLite WAL/FK/事务/当时迁移链   | PASS        | 当时 Data 与 Rust 迁移门禁通过。                                                          |
| 原子备份与恢复                  | PASS        | 当时权威表、派生数据重建、失败回滚及新增领域数据由 `7/7` 定向回归覆盖。                   |
| 安全导入导出                    | IN_PROGRESS | 自动化导入、Bundle/Markdown/TXT、PDF 路径已覆盖；DOCX 仍缺 Word/LibreOffice 逐页视觉 QA。 |
| 真实 Tauri WebView 稳定性       | NOT_RUN     | 长时中文 IME、500 万字符、磁盘耗尽、内存与强退恢复仍需固定基准机验证。                    |
| 隔离 Windows 用户安装矩阵       | NOT_RUN     | 最新候选未执行交互安装、快捷方式、首次启动、覆盖升级、卸载保留与重装。                    |
| Windows 代码签名                | BLOCKED     | 需要商业证书、时间戳和发布主体授权。                                                      |

## 2026-08-08 历史 Pro、Studio、Enterprise 与扩展边界

| 门禁                           | 状态        | 证据或缺口                                                                                      |
| ------------------------------ | ----------- | ----------------------------------------------------------------------------------------------- |
| 密文同步、恢复、撤销和保留协议 | IN_PROGRESS | 本地协议、存储与 Cloud PostgreSQL 自动化通过；真实双设备、对象存储和持续同步尚未闭环。          |
| Cloud 数据库最小权限角色       | PASS        | 全新库全套与最终真实库定向回归分层覆盖迁移/运行角色分离、严格 TLS、对象白名单、RLS 与审计边界。 |
| 生产 Cloud 部署                | NOT_RUN     | 缺真实 Kubernetes、DNS/TLS、监控、对象存储、邮件、支付与灾备环境。                              |
| 团队 RBAC、审阅与审计          | IN_PROGRESS | 服务端与本地核心自动化存在；真实团队 UI、身份提供商与运营演练未闭环。                           |
| Marketplace 安装治理           | IN_PROGRESS | 本地安装与 Cloud 合约路径有回归；高权限运营操作仍缺强服务端 MFA。                               |
| 安全更新链                     | IN_PROGRESS | 客户端校验、反回滚、密钥轮换和发布套件通过；正式域名、通道、签名与独立密钥托管未完成。          |
| Web Guest 本地模式             | PASS        | 生产构建与真实 Chromium `2/2`。                                                                 |
| Web Cloud/项目/团队路径        | IN_PROGRESS | 尚未完成，不得把 Guest 路径冒充完整 Web 产品。                                                  |
| Android 核心 JVM 验证          | PASS        | `24/24`。                                                                                       |
| Android 真机与系统密钥库       | NOT_RUN     | 缺 Android SDK instrumentation 和真机 KeyStore 验证。                                           |
| 私有部署升级、回滚与恢复脚本   | PASS        | 自动化 `8/8`；不代表客户目标环境验收。                                                          |
| SSO 与组织策略                 | BLOCKED     | 需要目标 IdP、商业配置和真实租户。                                                              |
| RPO/RTO、容量与故障演练        | NOT_RUN     | 需要生产等价环境、监控和已批准的恢复目标。                                                      |

## v0.2.4 修复版第二阶段真实 Windows Tauri 测试 Prompt

> 适用对象：`v0.2.4` 已发布唯一提交和对应 Windows Tauri 安装包。  
> 当前结论：`RELEASED_PREVIEW / CODE_FIXED_AUTOMATION / REAL_TAURI_NOT_RETESTED / PROVIDER_LIVE_NOT_RUN`。  
> 调用预算：阶段 A 最多 6 次低成本真实模型动作；安全门禁通过后，阶段 B 才可进行 20–30 次长篇调用。

请在第二台 Windows 电脑上执行下列任务。测试人员可在 InkShadow 界面中手动输入自己的 Provider 凭据，但不得让
Codex、测试脚本、日志、诊断包或截图读取、打印、传输或保存 API Key。fake、临时 SQLite、Chromium CSS
zoom 和旧 v0.2.3 报告都不是新候选的真实 Tauri 通过证据。

### 测试前记录

记录候选版本、唯一 commit SHA、干净工作树、安装包字节数/SHA-256/签名、Windows 版本、系统显示缩放、分辨率、
Tauri/Wry/WebView2 版本、Provider/精确模型 ID，以及 InkShadow 账本和 Provider 控制台的脱敏计数基线。准备两份隔离数据：
全新 Windows 用户/AppData；从原 v0.2.3 测试备份制作的可丢弃副本（含幽灵连接和挂起账本）。不在原取证数据上就地测试。

### 强制安全停止条件

任一情况发生时立即停止所有后续 Provider 动作，保留当前窗口、账本、脱敏诊断和 Provider 计数，不重复点击：

- Candidate 接受/拒绝、页面打开/切换、应用启动、备份或恢复触发未披露的模型调用；
- 同一动作、授权 ID 或幂等键产生重复派发/重复计费；
- 私密章节、密钥、Prompt、正文或模型完整回复出现在不应出现的日志、诊断或 payload；
- 正文、旧不可变版本、Candidate 或确认设定被静默覆盖、丢失、串作品或串章节；
- 取消、崩溃或重启后长期 `running`，或 `ambiguous` 被自动重发；
- UI 显示就绪/10 项核心任务可用，同一任务的真实派发前检查却确定性失败；
- 超过当前阶段调用预算，或本地账本与 Provider 控制台保守计数无法对账。

### 阶段 A：最多 6 次低成本回归

每次动作前后立即对账，目录读取、失败或“可能没计费”也要保守记录。

1. **全新配置（最多 1 次）**：从空 AppData 启动，未配置界面不显示幽灵 ready；手动保存 Provider/精确模型，只执行 1 次无作品内容能力验证。重启后连接、目录、路由、凭据摘要和 readiness 一致，重启为 0 调用。
2. **Candidate 拒绝与接受（最多 2 次）**：一次短续写后拒绝 Candidate 并重启，正文/旧版/拒绝决定不变；再做一次短续写并接受 Candidate，正文与新不可变版本正确。从接受到重启，Provider invocation 增量必须精确为 0。本地搜索、因果投影或故事关联等无需 Provider 的可重建任务可以执行；不得出现新的云端摘要、长期记忆、事实抽取或其他正文派发。报告必须把已发布 `v0.2.3` 的历史隐式调用与新候选的当前结果分栏记录。
3. **开书三槽（最多 3 次）**：事前披露 3 次独立调用、Provider/精确模型、可能费用和无自动重试；只执行一批。三槽稳定 ID、显示序号、invocation ID 与终态一一对账；部分成功保留成功卡且不重编号，取消/`not_dispatched`/`ambiguous`/失败各自终结，页面、任务中心与账本不留 `running`。

穿插执行下列 0 调用检查：v0.2.3 升级副本启动时孤立调用按 dispatch boundary 结清为
`not_dispatched`/`ambiguous` 且不重发；保存连接→删除凭据→重启→原 ID 就地重绑；退役旧连接后新建同供应商连接且历史 invocation 仍可审计、retired duplicate 不进入 ready/路由；私密章节远程生成在 invocation/payload 前失败关闭；credential、route、catalog 或 capability 任一漂移时所有页面同步不可用，正文/版本/Candidate 不变。

只有保守计数不超过 6、用户动作与两个账本一一解释，且没有隐式调用、重复计费、长期 `running`、幽灵 ready、正文损坏或隐私越界，并导出脱敏报告得到人工明确批准后，才能进入阶段 B。

### 阶段 B：20–30 次长篇与故障恢复

另行明确费用授权后手动开始。通过合并长输出、大上下文和可合并的故障注入，将批次控制在 20–30 次；不得为了达数而自动重试、循环点击或放宽停止条件。必须覆盖：

1. 全新 Windows 用户/AppData 的干净首次配置（可引用阶段 A）。
2. 从 v0.2.3 幽灵连接和挂起账本升级后的恢复。
3. Candidate 拒绝后重启。
4. dispatch 前取消、dispatch 后 `ambiguous`、失败后只经用户新授权手动重试，同一授权/幂等键不二次进网。
5. 至少 8 次长输出，累计至少约 30,000 个中文可见字符，每次仍只生成隔离 Candidate。
6. 至少 3 次在大于 20,000 字符项目上下文中调用，记录采用/舍弃来源和 token 预算。
7. 条件允许时 1 次大于 50,000 字符上下文调用；不允许时记录 `NOT_RUN` 和精确原因。
8. 私密章节云端 dispatch fail closed；本地路径仅绑定已验证回环身份。
9. DeepSeek 401、429、超时、断流、截断和格式异常；保留真实 invocation 与脱敏底层 cause。
10. 在 reserved、bound 和 dispatched 边界分别结束应用进程；重启后不自动重发。
11. 备份/恢复正文、不可变版本、Candidate、路由、调用账本、取消/`ambiguous` 和不含密钥的连接摘要；恢复不含密钥且不自动发送。
12. 真实 Windows 系统 200% DPI：正文为视觉中心、可关闭 Drawer、无页面水平/不可达嵌套滚动、主操作至少 44px、键盘/焦点/Escape/焦点返回有效；不得用 CSS zoom/DPR2 代替。
13. 真实 Markdown/DOCX/PDF/EPUB 导出，用独立工具打开检查内容、章节、编码、排版和非占位产物。
14. 真实卸载/重装后的本地数据、正文/版本/备份和 Credential Manager 行为，不导出密钥。

每个动作使用稳定测试 ID，记录事前披露和预期调用数、脱敏项目/章节/Candidate/版本 ID、精确
connection/catalog/provider/model/route/revision/capability、dispatch boundary/invocation ID/终态/token/费用/脱敏 cause、操作前后正文 SHA-256/版本/Candidate 和两个账本差值。只用
`PASS / FAIL / BLOCKED / NOT_RUN / AMBIGUOUS`，不用“看起来正常”。

交付脱敏压缩包：中文报告/开发摘要、动作→预期→本地账本→Provider 保守计数 CSV、脱敏诊断、关键截图、四种导出及 SHA-256、安装/升级/卸载记录与未执行清单。报告必须分开 v0.2.3 历史发现、新候选自动化、新候选真实 Tauri 复测和仍未运行项。只有真实执行的对应项目才可写 `VERIFIED_IN_WINDOWS_TAURI`。

## 商业发布阻断项

以下任一项未关闭都不允许把当前 Pre-release 升级为 Beta、GA 或商业正式版：

1. `P0`：轮换并审计项目附件中曾暴露的全部凭据；仓库秘密扫描通过不等于外部凭据已失效。
2. `P1`：取得 Windows 发布主体授权、Authenticode 证书与时间戳，冻结正式更新域名、通道及独立签名密钥托管。
3. `P1`：完成隐私政策、服务条款、EULA、AI/训练/Marketplace notices、SLA 与第三方许可文本的有权审批。
4. `P1`：使用最小权限真实凭据完成邮件、支付、对象存储、模型、翻译、短剧、训练与 SSO 联调。
5. `P1`：完成真实 IdP、签名许可证、不可变镜像仓库、Kubernetes、DNS/TLS、监控、备份恢复与灾备验证。
6. `P1`：完成独立密码学、应用安全、更新链和云数据库角色审计。
7. `P1`：完成最新 NSIS 的隔离用户安装/升级/卸载矩阵、真实 Tauri WebView 压力矩阵、DOCX 视觉 QA 和 Android 真机门禁。

## 发布结论

`v0.2.7` 已从唯一干净来源提交 `cb97876894d6f02c4c901745c95533da7b0260fe` 完成源码门禁、
未签名候选、远端持续集成、带说明标签、恰好三个公开附件与回下载复核，并作为工程预发行公开。
真实外部模型与最终安装程序扩展真机矩阵仍为外部条件阻塞；`v0.2.4`、`v0.2.5`、`v0.2.6` 与 `v0.2.7` 的既有
标签和附件均不能复用、移动或静默替换。

`v0.2.3` 的唯一提交、完整候选链、制品哈希、GitHub Actions、标签与公开附件回读已经完成；
真实 Tauri WebView + Keyring 冷启动、另一台电脑安装、192 次付费调用、2,496 项人工评分和真实 Provider
仍为 `NOT_RUN`，Novel Skill 继续 `KEEP_DISABLED`；
签名、真实供应商全矩阵、百万字真实作品全链路/WebView 压力、法律审批、生产部署与独立安全审计
也仍有未关闭门禁。

**当前结论：`v0.2.7` 已公开为不可静默替换的最新未签名工程预发行；`v0.2.3` 的隐式云调用安全公告继续有效。既有版本都不是测试版、正式通用版或商业正式版；上述外部验证完成前不得扩大发布结论。**
