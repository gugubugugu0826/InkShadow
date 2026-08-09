# InkShadow 当前执行状态

> 更新日期：2026-08-09  
> 源码与候选版本：`0.2.0`  
> 工程状态：当前工作树已完成 DeepSeek 文本能力探针 P0 修复及本地全仓/Rust 门禁；证据不包含真实 DeepSeek 凭据在线调用  
> 发布结论：**截至本段工程门禁记录，安装包候选尚未生成且本轮 P0 修复尚未发布；既有公开 `v0.2.0` Pre-release 只作为历史基线，不包含当前工作树改动**  
> 原因：仍需真实 DeepSeek API Key 的目录发现、能力探针、任务分工和基础评测端到端验收；商业签名、供应商全矩阵和隔离 Windows 安装矩阵也未完成

## 2026-08-09 DeepSeek P0 当前工作树

| 项目                   | 当前事实                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 根因与修复          | `PASS`；共享 64-token 无作品内容探针、DeepSeek Provider Registry 禁用探针思考、`reasoning_content`/可见正文分离、可见截断窄例外、能力证据/初始文本分工和诊断 schema v2 已接线 |
| 全仓发布前工程门禁     | `PASS`；`pnpm.cmd release:check` 用时 475.7 秒，生产构建、格式、秘密扫描、151 项许可证、20 包边界、Desktop release gate `17/17`、全部工作区类型检查、ESLint 与测试通过        |
| Desktop 测试           | `PASS`；207 files，1,440 passed，1 skipped，0 failed                                                                                                                          |
| Data / Cloud API / Web | `PASS`；Data 62 files / 357 passed；Cloud API 87 passed / 64 条外部 PostgreSQL 条件跳过；Web 33 passed                                                                        |
| Rust 原生层            | `PASS`；`pnpm.cmd check:rust` 完成 format、全 target 严格 Clippy `-D warnings` 和完整测试；152 passed，1 ignored，0 failed                                                    |
| P0 定向证据            | `PASS`；Desktop 9 files / 104 tests；Data migration + maintenance 2 files / 14 tests；`model_gateway` 63 passed / 1 ignored；Tauri `local_migrations` 5 passed                |
| Provider 与迁移口径    | Provider Registry 当前为 9 类；Data migration `0056` / Tauri `59`；发布脚本门禁为 17 项                                                                                       |
| 真实 DeepSeek 线上验收 | `NOT_RUN`；没有读取或使用用户 API Key，不能将本地/模拟协议测试标为供应商 `VERIFIED`                                                                                           |
| 本轮发布与安装包       | 截至本段工程门禁记录为 `NOT_RUN`；`release:check` 不等于打包，若随后从干净提交生成候选，须以候选清单记录来源提交、SHA-256 和大小；GitHub Release 尚未发布                     |

精确命令与分包结果见 [`TEST_RESULTS.md`](TEST_RESULTS.md) 和
[`2026-08-09-DEEPSEEK-TEXT-PROBE-P0.md`](2026-08-09-DEEPSEEK-TEXT-PROBE-P0.md)。

## 2026-08-09 已发布 v0.2.0 历史基线（不含本轮 P0）

| 项目                   | 当前事实                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 源码提交               | `PASS`；发布标签 `v0.2.0` peeled 后精确指向 `435454b952bead1014dd7d44f0f4806d70fce7e5`                                                         |
| 全仓发布预检           | `PASS`；151 项依赖许可证、20 包边界、17 项发布脚本、20 个 TypeScript 工作区、全仓 ESLint、`2,569 passed / 65 skipped`                          |
| Rust 原生层            | `PASS`；format、严格 clippy、`147 passed / 1 ignored`；忽略项只是真实 Ollama 条件测试                                                          |
| 全工作区生产构建       | `PASS`；公开桌面前端 82 文件 / 6,325,162 bytes；团队功能双开构建 87 文件 / 6,412,787 bytes，均低于 6,422,528 bytes 预算                        |
| Desktop production E2E | `PASS`；`9/9`，覆盖三入口、项目生命周期、自动保存/恢复、Candidate 隔离、生产 PDF Worker、响应式布局与本地凭据边界；DPR2 焦点场景另重复 `10/10` |
| 干净提交完整候选链     | `PASS`；703.9 秒，包含 release check、Rust、release E2E、Tauri/NSIS 和打包后来源复核                                                           |
| Windows x64 未签名候选 | `PASS`；7,429,121 bytes；SHA-256 `6E824533BE5FBBBC2693C8F3891BA2CDD5850B39BA17674C8D1A4EF3E1D2FC20`                                            |
| GitHub                 | `PASS`；Actions run `31289865897` 三作业成功；公开 Pre-release：<https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.0>              |

本轮公开前端保留 PDF.js 6.1.200 Worker 的 Apache 许可证、版本和 build 标识；默认公开构建不包含
四个不可达的 Studio 团队页面，团队能力双开时四个页面会重新进入产物。OpenAPI 文档生成器只从
`@inkshadow/contracts/openapi` 显式入口加载，不进入桌面运行时主入口。

本节记录提交 `435454b` 的既有公开工程预览，只代表该历史发布。它的候选链、制品哈希和 GitHub
地址不能替代上方当前工作树验证，也不能证明本轮 DeepSeek P0 已经发布或通过真实供应商验收。
本页后续带有 2026-08-08 或更早时间标签的测试和制品同样是历史记录。

## 2026-08-08 DESIGN v0.3.1b 历史实现快照

| 项目             | 当前事实                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1          | 三入口、可恢复的一句话开书、创建前摘要、空正文+AI 建议版本、导入试改/逐章处理、四区工作区、作品库状态和示例作品已接入；P08–P10 原位连接、成功分流和失败恢复已闭环                                                                                                                                                                                                                                                                                        |
| 正文安全链       | 接受 AI 建议、接受导入改写或追加式恢复历史版本后，以稳定版本 ID 幂等登记搜索、摘要、故事变化和故事关联任务；派生失败不回滚正文                                                                                                                                                                                                                                                                                                                           |
| 后台恢复         | Tauri worker 启动即检查、每 15 秒补跑，排队任务有 30 秒前台宽限；任务中心对合法失败提供立即重试；失败阶段掩码让重试跳过已成功阶段；历史回填规则 v2 兼容旧版本任务，开关后来开启时只补缺失阶段，终态失败按阶段代数恢复；专用到期查询按最早到期分页，常规单轮扫描 1,000/处理 200，历史回填单轮最多 5 条，不受任务中心展示窗口限制                                                                                                                          |
| 创建资料         | 三条创建旅程共享 ProjectSeed；只有作者确认且非空字段进入真实续写上下文，未确认 AI 推测被排除                                                                                                                                                                                                                                                                                                                                                             |
| 数据与隐私       | Data migration 到 `0045`、Tauri migration 到 `48`；应用相关持久表共 136 张，其中恢复契约只复制 135 张权威表并清空 4 个派生根表，内容无关的远程派发租约表不恢复；`0042`–`0044` 分别完成检查快照级联、StoryFact 人工别名消歧和规划逐项采纳意图，`0045` 为项目上下文远程 generation / embedding / rerank 增加完整原生网络生命周期租约与派发前原子指纹复核；租约期间只阻止新增或转入 `local_only` 及项目删除，普通正文和自动保存仍可写；默认导出排除私密章节 |
| 导入导出         | TXT、Markdown、DOCX、EPUB、静态 HTML 和可提取文本 PDF 导入；Bundle、Markdown、TXT、EPUB 3、结构化报告、DOCX、PDF 导出                                                                                                                                                                                                                                                                                                                                    |
| 自动备份         | 本地 03:00、启动补最近漏跑、每小时重检、默认保留 30 天；清理受所有权标记、租约、清单、文件身份、完整性和 SHA-256 共同约束                                                                                                                                                                                                                                                                                                                                |
| Desktop 当前回归 | `PASS`；199 个测试文件，1,282 项通过、1 项真实 Ollama 条件跳过                                                                                                                                                                                                                                                                                                                                                                                           |
| Workspace        | `PASS`；格式、秘密、151 项许可证、20 包边界、20 个 TypeScript 工作区、全仓 ESLint 和 2,379 项测试通过；64 项 PostgreSQL 条件测试与 1 项真实 Ollama 测试显式跳过                                                                                                                                                                                                                                                                                          |
| Rust             | `PASS`；format、严格 clippy 通过，146 项通过、1 项真实 Ollama 条件忽略                                                                                                                                                                                                                                                                                                                                                                                   |
| 发布前端         | `PASS`；83 个文件 / 6,239,149 bytes，产物门禁与 production Chromium E2E `5/5` 通过                                                                                                                                                                                                                                                                                                                                                                       |
| Windows 候选     | `PASS`；v0.2.0 x64 未签名 NSIS 已生成、复核哈希并归档，主程序为 `Windows GUI (2)`                                                                                                                                                                                                                                                                                                                                                                        |

Workspace 的 65 项显式跳过由 64 项 Cloud PostgreSQL 条件测试和 1 项真实 Ollama 测试组成；Rust
另有 1 项真实 Ollama 条件测试被明确忽略。百万字搜索微基准已通过，但真实云供应商、百万字真实
作品全链路/WebView 压力、目标宽度人工视觉矩阵和安装升级矩阵仍不得由本地模拟测试外推为完成。

## 2026-08-08 15:04 历史 v0.2.0 产品重构候选

| 项目           | 当前事实                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows 候选   | `archive/2026-08-08-v0.2.0-product-rebuild-candidate/artifacts/墨影 InkShadow_0.2.0_x64-setup.exe`                                                     |
| 独立安装器     | `installer/v0.2.0-product-rebuild/墨影 InkShadow_0.2.0_x64-setup.exe`                                                                                  |
| 候选大小/摘要  | 7,404,796 bytes；SHA-256 `99D8EB731F6DF16F5DAEA05BB7AC9D640D1498B19853F45776CD30A1BB36912A`                                                            |
| 版本与签名     | FileVersion / ProductVersion `0.2.0`；Authenticode `NotSigned`                                                                                         |
| 原生程序       | 25,018,368 bytes；SHA-256 `3AF505EEE8B49B87C01B5249B72F77CAFC55916F1C1F53A6DB0DC9D308072B84`；PE Subsystem `Windows GUI (2)`                           |
| 源输入指纹     | 818 文件 / 12,916,755 bytes；SHA-256 `0ad7dfd95176cf93bf25ed8772375c362bf88cabf718629adb334e862586b0ca`                                                |
| 前端制品指纹   | 83 文件 / 6,239,149 bytes；SHA-256 `a2c19794f4230f09d126774b4e2e97f81f73bd8807febe956da2a48fed4a2e13`                                                  |
| 构建与 E2E     | 全仓 release check、release artifact gate、production Chromium E2E `5/5`、Tauri/NSIS 未签名打包通过                                                    |
| 安装与升级验证 | `NOT_RUN`；隔离用户首次启动、覆盖升级、卸载、重装和数据保留矩阵仍需目标 Windows 环境                                                                   |
| 工作区清理     | 已删除可再生成的 `apps/desktop/src-tauri/target`（13.062 GiB）；旧 `.tmp` 与 Playwright 报告已整体移入当前候选的 `evidence/`，当前项目总量约 0.554 GiB |

该候选只对应当时的工作树，已被 2026-08-09 的源码收口取代，不得当作本次发布制品。商业签名、真实供应商、隔离安装矩阵和外部审计完成前，不得提升为商业正式发布。

## 2026-08-08 09:00 历史 v0.2.0 候选

| 项目           | 当前事实                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Windows 候选   | 原生成路径为 `apps/desktop/src-tauri/target/release/bundle/nsis/墨影 InkShadow_0.2.0_x64-setup.exe`；该可再生成构建缓存现已清理 |
| 生成时间       | `2026-08-08 09:00:16 +10:00`                                                                                                    |
| 候选大小/摘要  | 7,333,212 bytes；SHA-256 `4425B8E7B5E18B76B63E93481D3CA2D1251FF873990545DFB753672B8DC6571B`                                     |
| 版本与签名     | FileVersion / ProductVersion `0.2.0`；Authenticode `NotSigned`                                                                  |
| 原生程序       | 24,635,392 bytes；SHA-256 `E91B57BE79769594F884E35981FB97FEDE6A1ED2CDF08B50896C0BC91D42DAC7`；PE Subsystem `Windows GUI (2)`    |
| 源输入指纹     | 799 文件 / 12,195,475 bytes；SHA-256 `1ded2bb88ab757c87a8e641166ecc04762edc2521d4714cb2e39f2c21b15375a`                         |
| 前端制品指纹   | 81 文件 / 6,284,151 bytes；SHA-256 `abb51e4fbafe3ad5b21cb139b356b599f7994909c4da1e5a59c0e2490f16f8d7`                           |
| 构建与 E2E     | release artifact gate、production Chromium E2E `5/5`、Tauri/NSIS 未签名打包通过                                                 |
| 安装与升级验证 | `NOT_RUN`；尚未执行隔离用户首次启动、覆盖升级、卸载、重装和数据保留矩阵                                                         |

该候选只对应当时的构建输入，已被本页上方 15:04 的当前候选取代。安装包未使用商业代码签名，因此 Windows
可能显示未知发布者提示。签名或重新打包会改变字节与哈希，届时必须重新记录。

## 2026-08-02 v0.2.0 历史候选

| 项目           | 当前事实                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 产品主链       | 三入口、一次一问开书、导入分析/试改/逐章建议、专业创建、正文/规划/设定/检查四区工作区已接入                                          |
| Model Hub      | 8 类供应商预设、22 类小说任务、能力证据、主备、隐私/费用、调用账本和安全凭据边界已接入                                               |
| 小说智能       | StoryFact、确认因果图、十二层续写上下文、章节摘要、连续状态提取、证据化检查、What-if、反馈学习、规划候选与图片生成按能力台账条件开放 |
| 完整自动化     | 格式、秘密、151 项运行时依赖许可证、20 包边界、release config、20 workspace TypeScript、全仓 ESLint 和所有 workspace 测试通过        |
| Desktop        | 173 个测试文件；1,061 passed、1 skipped                                                                                              |
| 关键包         | Data 319 passed；Story Core 118 passed；Web Guest 33 passed                                                                          |
| Rust           | `cargo fmt --check` 与严格 clippy 通过；116 passed、1 ignored                                                                        |
| 发布前端       | 978 modules；76 个正式文件；产物完整性门禁通过；production Chromium E2E `5/5`                                                        |
| Windows 候选   | `archive/2026-08-01-v0.2.0-candidate/artifacts/墨影 InkShadow_0.2.0_x64-setup.exe`                                                   |
| 候选大小/摘要  | 7,179,887 bytes；SHA-256 `AA4C4C2EDFFB29B810B2BBAFBBF4484DAD2A20EED98BD8708F28E018D5DE856A`                                          |
| 版本与签名     | FileVersion / ProductVersion `0.2.0`；Authenticode `NotSigned`                                                                       |
| 原生程序       | 24,229,888 bytes；SHA-256 `7E0E206DB0577C044D26395FD54F0B7413A23B1719DAEFE60A6B211DE1B51E0E`；PE Subsystem `Windows GUI (2)`         |
| 安装与升级验证 | `NOT_RUN`；没有执行隔离用户首次启动、覆盖升级、卸载、重装和数据保留矩阵                                                              |

候选归档还保存 756 个源输入文件的源码指纹和 76 个正式前端文件的产物指纹。首次完整候选链
在发布前端门禁处发现 inline favicon 的 SVG namespace 误报；改为本地 favicon 文件后，格式、
秘密、lint、`git diff --check`、production build、产物门禁、E2E 和 Tauri/NSIS 打包均重新通过。
该过程没有把失败的一次运行记录为 PASS。

当前各 Phase 的真实完成边界以 [`../product-rebuild/README.md`](../product-rebuild/README.md)
和 `06-PHASE-3-TO-5-CAPABILITY-LEDGER.md` 为准。真实供应商、百万字与安装矩阵缺口不得由
本地/模拟测试外推为已完成。

## 2026-07-31 页面整改候选（历史）

| 项目           | 当前事实                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 完整候选链     | `CI=true pnpm release:candidate:unsigned` 从头执行通过；Desktop production Chromium E2E `5/5`                                |
| 源输入指纹     | 624 文件 / 8,689,055 bytes；SHA-256 `9e30417a8477aee5da0d55f82408165abeaec191e54c2e14261b490f4f4bd5ac`                       |
| 发布前端       | 67 文件 / 5,172,183 bytes；SHA-256 `b14c634275c2c7b9b96999f959aaa8741e31933c302bee2738af7628380ce805`                        |
| Windows 候选   | `archive/2026-07-31-page-remediation-candidate/artifacts/墨影 InkShadow_0.1.0_x64-setup.exe`                                 |
| 候选大小与时间 | 6,843,820 bytes；`2026-07-31 11:59:40 +10:00`                                                                                |
| 候选 SHA-256   | `0D7E95E468E2A90EE1F7C0DD77058BDC4FC9ABA935DEDC2792B28AB4B00EA189`                                                           |
| 版本与签名     | ProductVersion / FileVersion `0.1.0`；Authenticode `NotSigned`                                                               |
| 原生程序       | 23,475,200 bytes；SHA-256 `4081A6E067940A018C3173D4D1A2BAF6EAE297E2D23E4B61373DB9222134A8BA`；PE Subsystem `Windows GUI (2)` |
| Rust 补充门禁  | format 与严格 clippy 通过；`cargo test` 93 passed、1 ignored、0 failed                                                       |
| 安装与升级验证 | `NOT_RUN`；没有执行首次启动、覆盖升级、卸载、重装和数据保留矩阵                                                              |

构建目录和归档中的安装包、原生程序、源码基线及发布清单均已逐一复算摘要，复制前后完全一致。
首次候选链暴露旧 production E2E 仍查找整改前的项目卡片 `h3`；测试契约调整为当前 `h2`
后，定向 E2E `5/5` 和完整候选链均重新执行并通过。

## 2026-07-31 页面细节整改增量

本轮依据 `docs/页面细节审查报告-v2.md` 对 Desktop、共享 UI 与 Web Guest 的页面细节进行集中整改。已落地的主要变化包括：

- Desktop 内容区改为独立滚动容器，设置长页面不再被外层固定高度截断；
- 窄窗口侧栏改为可访问抽屉，覆盖焦点进入、背景不可操作、`Escape` 关闭与焦点返回；
- 设置页分区锚点、标题层级、路由标题与焦点恢复完成收口；
- 项目上下文导航、未知路由、加载/失败/空状态、禁用态、保存等待反馈与通知优先级得到补齐；
- 云端登录检查增加失败后的重试与本地继续入口，Marketplace 未开放入口不再误导用户；
- Web Guest 高风险浏览器提示支持拒绝与复查，备份导入执行严格校验；自动锁定前除正式保存外还会尽力写入仅含密文的临时恢复草稿，失败场景可在下次解锁找回；
- 删除、退出、卸载、角色与责任变更等高风险操作增加明确确认，面向用户的内部术语得到收敛。

本轮增量证据如下，彼此按运行层分开记录：

| 范围               | 结果                                                                                                              | 状态 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | ---- |
| Desktop 默认全套   | 118 个测试文件；766 passed、1 skipped；生产构建 912 modules                                                       | PASS |
| 共享 UI            | 类型检查、lint；5 个测试文件、20 个测试通过                                                                       | PASS |
| Web Guest 整改快照 | 4 个测试文件、33 个测试通过；生产构建 63 modules；Chromium E2E 2/2                                                | PASS |
| 全仓静态检查       | 20 个 workspace 的 TypeScript；ESLint、Prettier、`git diff --check`                                               | PASS |
| Desktop 浏览器布局 | 900×700 下主内容 `clientHeight=624`、`scrollHeight=4110`，`scrollTop` 可由 0 变为 900；body 与 shell 高度均为 700 | PASS |
| 设置页锚点         | `#data-transfer` 定位后 `activeId=data-transfer`，目标顶部与主内容顶部对齐                                        | PASS |
| 窄窗口抽屉         | 705 px 下焦点进入、背景 inert、`Escape` 关闭与焦点返回                                                            | PASS |
| Web 页面交互       | 高风险提示拒绝/复查与标题层级                                                                                     | PASS |

Web E2E 首跑通过 `VersionError` 暴露了测试固定的 IndexedDB 版本与生产数据库 v2 漂移；
测试现改为复用导出的 `WEB_GUEST_DATABASE_VERSION`，随后重新执行并通过 `2/2`。

上述增量已纳入 2026-07-31 历史候选链。它仍不是 Tauri WebView
交互或安装包安装行为验证。2026-07-30 的未签名 NSIS 不包含本轮源码整改，其哈希和
E2E 证据继续只证明当时的历史快照。

## 2026-07-30 候选基线（历史证据）

| 项目          | 当前事实                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------- |
| 本地数据      | Tauri SQLite schema v32；97 张可恢复持久表纳入原子备份/恢复清单                                 |
| 云数据        | Cloud PostgreSQL migration `0016_community_marketplace.sql`                                     |
| 云契约        | OpenAPI 3.1.1；81 项 operation                                                                  |
| 云权限        | migration/runtime 双角色；生产 `sslmode=verify-full`；显式对象 allowlist；租户表 FORCE RLS      |
| 发布前端      | release manifest 67 个文件、5,151,424 bytes，并记录逐文件 SHA-256                               |
| Windows 候选  | `墨影 InkShadow_0.1.0_x64-setup.exe`，ProductVersion `0.1.0`                                    |
| 候选大小/哈希 | 6,837,040 bytes；SHA-256 `1693E7F0598A7262644936A481216A15D7B5BC19BEE03155DB3AD77A0F60EBA8`     |
| 候选签名      | Authenticode `NotSigned`；仅供内部验证                                                          |
| 工作区体积    | 清理 30 个可再生目录后为 0.408 GiB；最终候选与证据保存在 `archive/2026-07-30-delivery-evidence` |

该历史候选文件时间为 2026-07-30 00:58:47 +10:00，晚于当轮构建开始。其 PE Subsystem 已复核为
`Windows GUI (2)`，正式构建不会再创建用户可见的控制台窗口。尚未运行该
历史安装包，也未在隔离 Windows 用户中执行安装、覆盖升级、卸载、重装和数据保留验证。
页面整改源码当时由 2026-07-31 候选覆盖；当前发布基线已由本页顶部的 v0.2.0 候选取代，
本节旧候选继续作为不可改写的历史证据保留。

## 已完成的工程能力

- Windows Tauri 2 + React 19 桌面壳、本地无账号启动、项目/章节/大纲、自动保存、
  RecoveryDraft、追加式版本、回收站、备份恢复、任务通知、设置和脱敏诊断已形成真实纵切。
- 本地原生迁移推进至 v48；135 张可恢复权威表覆盖同步、团队、审阅、用量、模板、
  权威提取、多 Agent、翻译/短剧、微调治理、Marketplace 安装、ProjectSeed、私密章节、
  StoryFact、因果关系、上下文历史、反馈学习、检查快照与规划选择性采纳元数据。关键词、FTS、GraphRAG
  与向量投影仍按可重建派生数据处理，不冒充恢复权威。另有 1 张不含用户内容的临时远程派发租约表，
  因而应用相关持久表总计 136 张；一致性备份可能物理包含该表，但恢复事务明确不复制它。
- 已恢复发布过的本地迁移 v4 原始字节，历史用户数据库的 v1–v11 SHA-384 全部重新匹配；
  `project_manifest` 仍由后续 v16 迁移引入。固定校验值回归阻止再次改写已发布迁移。
- AI Candidate、逐项 Diff、三方冲突、预检、预算、取消/重试、幂等、离线任务、供应商
  回执、七角色路由、本地多 Agent、权威提取和本地 Ollama 分层回归已完成。
- TXT、Markdown、DOCX、静态 HTML 与可提取文本 PDF 的安全导入，以及
  Bundle/Markdown/TXT、结构化报告、DOCX 和离线图像型 A4 PDF 导出已实现。
- 云端身份、会话、设备、项目密钥 envelope、ciphertext-only 同步、删除、团队/RBAC、
  加密审阅、团队模板、AI 用量/配额、Enterprise OIDC 策略和 Community Marketplace
  已进入严格契约、Cloud Client、Cloud API、PostgreSQL 与桌面边界。
- Cloud API 长期进程不持有迁移权限；`--migrate-only` 启动模式、Kubernetes
  initContainer migration secret、runtime secret、CA 挂载、对象/函数 allowlist、
  SECURITY DEFINER ACL 与双向角色关系检查已落地。
- 安全更新协议已实现 manifest 签名、密钥轮换、sequence/版本反回滚、security floor、
  SSRF/DNS rebinding 防护、受限暂存 ACL、摘要/Authenticode/时间戳/发布者复核和独立
  verifier attestation。正式证书、域名、HSM/离线根与生产轮换演练仍是外部门禁。
- 独立 Web Guest 工作区使用加密 IndexedDB，生产构建和 Chromium 静态 E2E 通过；
  Android 纯 JVM 同步/加密缓存/KeyStore 边界 PoC 已完成；Enterprise 部署、备份恢复、
  监控、支持包和运行手册形成可复核工程基线。

## 2026-07-30 最近一次全仓与候选质量证据（历史）

| 层级                | 结果                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| 全仓门禁            | 根级 `pnpm check` 完整通过：格式、秘密、151 项许可证、20 包边界、发布配置、workspace 类型、lint、测试与构建    |
| unsigned candidate  | `CI=true pnpm release:candidate:unsigned` 整链通过                                                             |
| Desktop             | 常规全套 117 个文件：754 passed、1 skipped；真实 Ollama 权威提取另行 6/6                                       |
| Packages            | 17 个 packages，131 个测试文件、817 个测试通过                                                                 |
| Rust                | 常规 93 passed、1 ignored；显式真实 Ollama 另行 1/1                                                            |
| Cloud PostgreSQL    | 真实 PostgreSQL 全套基线 37 个文件、151 个测试通过                                                             |
| Cloud 最终权限增量  | 后续 FORCE-RLS 收紧使用真实 PostgreSQL 定向 1/1 复核；这是全套基线后的增量证据，不宣称与 37/151 为同一最终快照 |
| Web                 | Vitest 4 个文件、22 个测试；生产静态 Chromium E2E 2/2                                                          |
| Desktop release E2E | production `dist-release` 5/5                                                                                  |
| Android             | 纯 JVM 24/24；边界检查 core sources 14、production sources 15、snapshot 0                                      |
| Enterprise          | deployment/support/recovery 8/8，其中 manifest 安全门禁 3/3                                                    |
| Updater/release     | Rust updater 7/7、Desktop UI 3/3、Node manifest/release 9/9                                                    |

以上结果按测试层分开记录。真实 PostgreSQL、真实 Ollama、浏览器 production E2E 与默认
workspace 门禁并非同一个进程或同一环境，不把分层证据合并成单次“全真实环境”运行。

## 当前产品边界

- 本地 Community 创作工程闭环和内部候选已具备；这不等于 Windows 商业发布获批。
- 云身份、同步、团队和 Enterprise Feature Flag 在生产凭据、真实多设备 E2E、目标环境
  灾备与独立安全评审完成前保持默认关闭。
- Web 目前只完成 Guest 本机加密工作区；云登录、云项目、团队、账号恢复和多设备同步未实现。
- Android 目前是无 Activity/Service/网络权限的架构 PoC；尚无 Android SDK 构建、
  instrumentation、真机 KeyStore、后台同步、移动 UI 或发行包证据。
- DOCX 已完成结构与安全回读，但尚未在 Word/LibreOffice 做逐页视觉验收。
- 图像型 PDF 没有可选择/搜索文字层，也不宣称 PDF/UA 或屏幕阅读器可访问。
- v0.2.0 NSIS 是未签名工程预览候选；没有对其执行隔离用户安装、升级或卸载矩阵。
- 本地 Ollama 回归证明协议和实际推理路径可运行；GPU 显存、固定基准机冷/热启动和
  500 万字符真实 WebView 内存仍未测量。

## 外部 P0/P1 阻塞

1. 轮换并审计附件中出现过的全部凭据；完成前不连接对应远端环境。
2. 提供 Windows 发布主体、Authenticode 证书、时间戳、正式更新域名/channel、
   独立 verifier 和受控签名/HSM 流程。
3. 由有权人员批准隐私政策、服务条款、EULA、AI/训练披露、Marketplace notices、
   数据处理条款和 SLA。
4. 提供邮件、支付、对象存储、模型、翻译、短剧、trainer、SSO/IdP、许可证、镜像仓库、
   Kubernetes、DNS/TLS、监控和灾备的最小权限生产或沙箱凭据。
5. 完成独立密码学、应用与更新链安全审计，并关闭高风险发现。
6. 完成目标环境验证：隔离 Windows 安装/升级/卸载、真实 Tauri WebView 压力与 IME/
   磁盘满、真实多设备撤权/恢复/冲突、Linux PostgreSQL `age` 备份恢复与容量/故障演练、
   Android instrumentation/真机 KeyStore、Word/LibreOffice DOCX 视觉复核。
7. Marketplace 生产运营必须使用服务端强 MFA 与受控签名密钥，不能复用本地测试身份。

## 下一步

下一步是在目标 Tauri WebView 和隔离 Windows 用户中复核设置滚动、窄窗抽屉、安装、首次
启动、覆盖升级、卸载、重装与数据保留，并使用经授权的真实供应商环境完成互操作矩阵。
任何一项外部审批或凭据未完成，都不得把工程预览升级为 Beta、GA 或商业正式版。
