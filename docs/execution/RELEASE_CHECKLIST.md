# InkShadow 持续发布门禁

> 更新日期：2026-08-12  
> 当前源码与已发布工程预览版本：`0.2.2`  
> 当前结论：**`v0.2.2` 已从唯一干净提交完成本地候选、PR/main GitHub Actions、标签和公开附件复核，并发布为未签名 Pre-release；真实供应商、付费 Skill 评测、Novel Skill 默认启用和异机安装仍未验证**

状态只使用 `PASS`、`IN_PROGRESS`、`NOT_RUN`、`BLOCKED` 和 `N/A`。  
代码存在不等于发布门禁通过；只有可复核的测试、构建、签名、安装或人工验收证据才能标记 `PASS`。

## v0.2.2 当前发布门禁

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

`v0.2.2` 的唯一提交、完整候选链、制品哈希、GitHub Actions、标签与公开附件回读已经完成；
真实 Tauri WebView 交互、另一台电脑安装、192 次付费调用、2,496 项人工评分和真实 DeepSeek
仍为 `NOT_RUN`，Novel Skill 继续 `KEEP_DISABLED`；
签名、真实供应商全矩阵、百万字真实作品全链路/WebView 压力、法律审批、生产部署与独立安全审计
也仍有未关闭门禁。

**当前结论：`v0.2.2` 已公开为不可静默替换的未签名 Pre-release；它不是 Beta、GA 或商业正式版。上述外部验证完成前，不得扩大发布结论。**
