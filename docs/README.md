# 墨影 InkShadow 文档入口

> 当前发布目标：`0.2.16`；发布已获授权，必须在唯一干净提交完成全部本地门禁、远端持续集成、未签名安装包核验和附件回下载复核后才能形成预发行  
> 设计基线（Design Baseline）：`DESIGN v0.3.1b`  
> 最近治理复核：2026-08-30  
> 公开版本的精确状态以 [GitHub Releases](https://github.com/gugubugugu0826/InkShadow/releases) 为准；既有 `v0.2.15` 及更早标签、Release 与附件保持不可变。  
> 注意：设计版本用于界面与交互验收，不会自动改变应用版本。

0.2.16 当前修复选区生成结果落库与失败后安全离开、章节隐私反馈、自定义技能任务采用、检查页发送摘要入口、示例作品编辑提示、版本恢复跨章节提醒、普通界面命名和通知批量处理。示例入口与作品库继续复用既有明确身份。所有 AI 结果仍先与正文隔离，私密章节继续禁止远程发送；F17 只补齐既有 `selection_action` 接线，不新增数据库迁移。既有用户数据表仍由连续升级、备份与恢复门禁覆盖。
当前缺陷矩阵、根因、已执行命令、未执行人工项和发布边界见
[`execution/2026-08-30-V0216-RELEASE.md`](execution/2026-08-30-V0216-RELEASE.md)。0.2.15 及更早记录作为冻结历史保留。
`0.2.11` 人工复测候选的缺陷矩阵与证据边界继续作为历史记录保留，见
[`execution/2026-08-24-V0211-BLOCKERS-UI-REMEDIATION.md`](execution/2026-08-24-V0211-BLOCKERS-UI-REMEDIATION.md)。

`0.2.8` 仅生成了未签名人工复测安装包，未推送、未打标签、未发布；来源与保留边界见 [`product-rebuild/08-DESIGN-V031B-REALITY-MATRIX.md`](product-rebuild/08-DESIGN-V031B-REALITY-MATRIX.md#2026-08-24-v028-人工复测安装包)。

本目录同时保存当前规则、实现说明、执行证据和历史基线。为避免把旧页面说明或一次历史测试
误当成当前产品事实，阅读时必须先看文档状态，再看日期和适用范围。

## 文档状态

| 状态                    | 含义                                   | 使用方式                                        |
| ----------------------- | -------------------------------------- | ----------------------------------------------- |
| `AUTHORITATIVE_CURRENT` | 当前产品、数据或交付规则               | 发生冲突时优先；仍须由代码与当前运行证据支撑    |
| `SUPPORTING_CURRENT`    | 当前实现的详细说明                     | 补充权威文档，不得扩大“已实现”或“已验证”范围    |
| `EVIDENCE_CURRENT`      | 当前工作树的命令、结果、失败和制品证据 | 只证明记录所绑定的提交或工作树，不替代产品规则  |
| `TARGET_BASELINE`       | 目标设计或计划基线                     | 表示要达到什么，不表示当前已经实现              |
| `HISTORICAL`            | 历史审计、旧方案或旧测试快照           | 只用于追溯；不得作为当前 UI、迁移上限或发布状态 |

任意页面、接口、迁移、测试替身或截图单独存在，都不能把能力升级为 `VERIFIED`。P01–P44 只有在
真实动作、目标宽度、浅色/深色、键盘、加载/空/错状态和相关持久化全部完成当次复核后，才能逐项
标记为已验证。当前不得宣称 44/44 已验证，也不得把模拟协议测试写成真实供应商验收。

## 当前权威入口

| 状态                    | 文档                                                                                                                                       | 负责回答的问题                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `AUTHORITATIVE_CURRENT` | [`product-rebuild/README.md`](product-rebuild/README.md)                                                                                   | 下一阶段产品重构的当前阅读顺序、冲突规则和阶段边界 |
| `AUTHORITATIVE_CURRENT` | [`product-rebuild/01-INFORMATION-ARCHITECTURE-AND-FLOWS.md`](product-rebuild/01-INFORMATION-ARCHITECTURE-AND-FLOWS.md)                     | 三个创建入口、四区工作台和核心用户流程             |
| `AUTHORITATIVE_CURRENT` | [`product-rebuild/02-DATA-REUSE-AND-MIGRATION.md`](product-rebuild/02-DATA-REUSE-AND-MIGRATION.md)                                         | 数据复用、前向迁移、兼容与回滚                     |
| `AUTHORITATIVE_CURRENT` | [`product-rebuild/03-DELIVERY-PLAN-ACCEPTANCE-ROLLBACK.md`](product-rebuild/03-DELIVERY-PLAN-ACCEPTANCE-ROLLBACK.md)                       | Phase 0–5 顺序、验收、风险和回滚                   |
| `AUTHORITATIVE_CURRENT` | [`product-rebuild/12-NEXT-UNRELEASED-WRITING-MEMORY-AGENT-REALITY.md`](product-rebuild/12-NEXT-UNRELEASED-WRITING-MEMORY-AGENT-REALITY.md) | v0.2.5 写作模式、记忆、Agent 与当前证据边界        |
| `AUTHORITATIVE_CURRENT` | [`product-rebuild/14-V025-REQUIREMENT-COMPLETION-LEDGER.md`](product-rebuild/14-V025-REQUIREMENT-COMPLETION-LEDGER.md)                     | 用户增量要求逐项完成、发布证据与外部边界           |
| `SUPPORTING_CURRENT`    | [`front-end/README.md`](front-end/README.md)                                                                                               | 当前前端页面、路由、普通/专家体验和接口索引        |
| `SUPPORTING_CURRENT`    | [`back-end/README.md`](back-end/README.md)                                                                                                 | Cloud、Desktop 原生层、共享包与工程工具索引        |
| `EVIDENCE_CURRENT`      | [`execution/CURRENT_STATUS.md`](execution/CURRENT_STATUS.md)                                                                               | 当前执行状态；必须同时核对其中绑定的提交与运行日期 |
| `HISTORICAL`            | [`execution/TEST_RESULTS.md`](execution/TEST_RESULTS.md)                                                                                   | 历史工作树测试快照；不得替代 0.2.16 当前证据      |
| `EVIDENCE_CURRENT`      | [`execution/RELEASE_CHECKLIST.md`](execution/RELEASE_CHECKLIST.md)                                                                         | 当前版本的构建、打包、发布与外部门禁               |
| `EVIDENCE_CURRENT`      | [`execution/2026-08-30-V0216-RELEASE.md`](execution/2026-08-30-V0216-RELEASE.md)                                                           | 0.2.16 缺陷矩阵、当前验证与预发行门禁             |
| `HISTORICAL`            | [`execution/2026-08-29-V0215-RELEASE.md`](execution/2026-08-29-V0215-RELEASE.md)                                                           | 0.2.15 修复与发布历史                              |
| `HISTORICAL`            | [`execution/2026-08-27-V0214-RELEASE-BLOCKERS.md`](execution/2026-08-27-V0214-RELEASE-BLOCKERS.md)                                         | 0.2.14 上线阻断与发布历史                         |
| `HISTORICAL`            | [`execution/2026-08-26-V0213-BLOCKERS-REMEDIATION.md`](execution/2026-08-26-V0213-BLOCKERS-REMEDIATION.md)                                 | 0.2.13 修复与人工候选冻结证据                     |
| `HISTORICAL`            | [`execution/2026-08-24-V0211-BLOCKERS-UI-REMEDIATION.md`](execution/2026-08-24-V0211-BLOCKERS-UI-REMEDIATION.md)                         | 0.2.11 阻断缺陷、数据兼容与界面修复历史           |
| `HISTORICAL`            | [`execution/2026-08-25-V0212-RETEST-RELEASE.md`](execution/2026-08-25-V0212-RETEST-RELEASE.md)                                               | 0.2.12 缺陷、门禁与发布历史                       |
| `HISTORICAL`            | [`execution/2026-08-21-V026-REAL-DEVICE-DEFECT-REMEDIATION.md`](execution/2026-08-21-V026-REAL-DEVICE-DEFECT-REMEDIATION.md)                 | v0.2.6 发布前修复与真机聚焦历史证据                |

## 支撑文档

- [`front-end/PAGE_CATALOG.md`](front-end/PAGE_CATALOG.md)：Desktop 路由、对应文件、页面内容、
  真实动作与条件。
- [`front-end/INTERFACE_REFERENCE.md`](front-end/INTERFACE_REFERENCE.md)：DesktopRuntime、Tauri
  IPC、Model Hub、SQLite、Cloud API 与 Web Guest 数据边界。
- [`front-end/CREATION_JOURNEYS_AND_PROJECT_SEED.md`](front-end/CREATION_JOURNEYS_AND_PROJECT_SEED.md)：
  三条创建旅程共享的 ProjectSeed 合同。
- [`front-end/WRITING_EXPERIENCE_AND_CONSISTENCY.md`](front-end/WRITING_EXPERIENCE_AND_CONSISTENCY.md)：
  直接/专业模式、本地设定整理、StoryMemory、受控调查与 Provider 披露界面合同。
- [`back-end/CLOUD_BACKEND.md`](back-end/CLOUD_BACKEND.md)：Cloud API 代码边界；不代表生产云已部署。
- [`back-end/DESKTOP_NATIVE.md`](back-end/DESKTOP_NATIVE.md)：Tauri/Rust 可信边界、SQLite、凭据、
  模型网络和备份恢复。
- [`back-end/SHARED_PACKAGES.md`](back-end/SHARED_PACKAGES.md)：领域、应用、数据和共享包职责。
- [`back-end/ANDROID_OPERATIONS_TOOLING.md`](back-end/ANDROID_OPERATIONS_TOOLING.md)：Android POC、
  部署和工程工具；不属于当前 Phase 1 默认产品范围。
- [`product-rebuild/13-LOCAL-AGENT-RAG-ARCHITECTURE.md`](product-rebuild/13-LOCAL-AGENT-RAG-ARCHITECTURE.md)：
  本地 StoryMemory/RAG/TaskGraph 当前架构和明确延期项。
- [`product-rebuild/15-TENCENTDB-AGENT-MEMORY-ADAPTATION-AUDIT.md`](product-rebuild/15-TENCENTDB-AGENT-MEMORY-ADAPTATION-AUDIT.md)：
  固定上游提交的只读适配研究与不引入第二事实源/数据库/Key 的边界。
- [`GITHUB_PUBLISH_RELEASE_GUIDE.md`](GITHUB_PUBLISH_RELEASE_GUIDE.md)：公开仓库上传与 Release
  注意事项。实际公开范围以根 `.gitignore` 和当次提交清单为准。

## 目标与历史文档

- `DESIGN/`：`TARGET_BASELINE`。DESIGN v0.3.1b 规定视觉与交互目标；当前工作树应用清单为
  0.2.16 当前发布目标；v0.2.15 及更早发布证据保持不可变。设计版本不会自动改变应用版本，
  公开附件的精确大小和 SHA-256 以对应版本发布门禁为准。
- [`product-rebuild/00-PHASE-0-REALITY-AUDIT.md`](product-rebuild/00-PHASE-0-REALITY-AUDIT.md)：
  `HISTORICAL` Phase 0 起始审计；当前差异须再读增量现实矩阵。
- `docs/prototypes/`、`docs/state-matrices/`：目标原型或状态设计；除非文件明确标为当前，否则不是
  当前页面权威。
- `docs/execution/` 中带日期或提交号的旧报告：历史证据；不得证明更新后的工作树或安装包。
- `PROJECT.md`、`PLAN.md`、`PRD.md`、`SPEC.md`：仍可提供系统约束，但普通用户信息架构与本轮
  实施顺序以 `product-rebuild/` 当前权威文档为准。

## 当前产品不变量

- 默认入口是“从一个想法开始、导入小说、专业创建”；项目一级区域只有正文、规划、设定、检查。
- AI 结果先进入隔离的“AI 建议版本”（内部 Candidate）；明确接受前不得覆盖正文。
- 直接模式只简化交互，并授权接受后的确定性本地 delta 整理；它不授权自动接受正文或额外联网，
  重大设定仍须作者确认。
- 每次接受都创建不可变版本；当前接受后台只允许本地搜索、因果/故事关联等无需 Provider 的可重建投影，Provider 调用增量必须为 0；派生失败不得回滚已接受正文。
- 密钥保存在操作系统凭据库；正文、Prompt、密钥和完整模型响应不得写入调用账本或普通日志。
- 项目含仅本机章节时，所有读取项目内容的远程模型派发失败关闭。
- 缺少凭据、路由、能力或真实输出时显示失败或跳过，不生成看似来自供应商的替代数据。

## 三层工程验证

开发中的验证按范围逐层扩大，不用每次修改都从头运行完整门禁，也不得把较小范围的结果冒充
发布证据：

1. `pnpm verify:focus -- <文件或目录...>`：只检查明确文件及所属工作区。测试文件定向运行；
   普通源码运行所属工作区完整测试；脚本变更统一运行全部脚本测试。
2. `pnpm verify:affected`：读取相对当前 `HEAD` 的已跟踪变更和未跟踪文件，包含全部传递
   依赖方。可用 `-- --base origin/main` 指定可信基线，用 `-- --dry-run` 只查看计划。
3. `pnpm release:check`：冻结候选前的完整源码门禁；仍须另行运行原生层、正式网页旅程、
   安装程序和来源证明。

根配置、数据库迁移、原生依赖配置和未知路径会自动升级到完整门禁；原生源码会额外运行
`check:rust`。没有变更时命令明确报告未执行，不将空运行为通过。`test:scripts` 递归收集
`scripts` 下全部 `.test.mjs` 文件并拒绝符号链接；`check:desktop-release` 只核对发布配置，
`release:check` 和 `test:all` 均明确包含脚本测试。`test:watch` 使用桌面端自己的测试配置。

## 维护规则

1. 产品事实变化时，先更新 `product-rebuild/`，再同步 `front-end/`、`back-end/` 和执行证据。
2. 新 SQLite 结构只能新增前向迁移，并同步备份恢复白名单、顺序和测试。
3. 任何精确测试数量、制品哈希或发布结论只能写入与当次提交绑定的执行证据；概览文档不复制
   尚未重跑的数字。
4. 历史文件不倒改成当前事实；在索引中降级为 `HISTORICAL`，或在文件顶部明确适用快照。
5. 公开 GitHub 时只提交根 `.gitignore` 允许的文档，不使用强制添加绕过公开范围。
