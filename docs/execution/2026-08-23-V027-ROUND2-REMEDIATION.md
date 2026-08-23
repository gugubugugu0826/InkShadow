# v0.2.7 两轮复测缺陷修复报告

> 日期：2026-08-23；最近更新：2026-08-24  
> 状态：2026-08-24 后续增量已通过聚焦回归、完整源码门禁和原生层门禁；正式网页旅程必须在干净提交上运行。尚未发布，现有 v0.2.7 标签、安装包和附件保持不变。  
> 发布判断：不建议现在发布。目标现场数据库、现场诊断和真实安装复测未取得或未执行；以后如发布修复版，必须使用新版本号并等待单独指令。

## 一、基线与证据边界

- 用户提供源码包：`C:/Users/zepli/Downloads/v0.2.7-20260823-1207.zip`。
- 源码包 SHA-256：`866511333f4bb1de22aa4ed8e51667aca4acf5102c52ca826cb17f21b2af6598`。
- 已发布 v0.2.7 源码提交：`cb97876894d6f02c4c901745c95533da7b0260fe`。
- 已发布 v0.2.7 标签对象：`37a40ddff9ea9aba27549f13f27718e319e2748e`。
- 修复分支：`codex/v0.2.7-round2-fixes`；应用版本仍为 `0.2.7`。
- `v0.2.7-20260823-1207` 与 `v0.2.7-round2` 中现有报告和截图按只读材料使用；测试报告只作为缺陷线索，修复结论重新绑定当前源码和下列命令。
- 第二轮现场数据库、诊断包和日志未随材料提供。
- “橘猫第一章”“深夜电台”的现场数据库、原始诊断文件、准确触发行、旧版应用调用栈和组件调用栈：**未取得**。
- 未读取或输出凭据原文；未执行真实付费模型调用。

## 二、C2、C3 根因

### C2：有内容项目进入持久错误边界

当前源码能够稳定构造并证明两层根因：

1. 旧候选读取对整组可选候选执行严格反序列化，一条坏候选就会让整组读取失败。
2. 编辑器又把候选读取与项目、章节、不可变版本放入同一个聚合读取；可选派生坏行因此拖垮正文页。旧“重新加载”仍走同一严格读取，只会重复进入无信息错误边界。

修复后，可选坏候选原行不删除、不改写，只记录隔离原因；安全候选和权威正文继续打开。项目、章节或不可变版本本身不安全时仍失败关闭，禁止写入，并提供支持编号、诊断导出、备份/恢复和真正重新读取入口。

由于目标数据库和旧调用栈未取得，无法排除旧版本反序列化、共享任务元数据、故事事实或其他坏行。上述结论是当前源码与构造坏行的准确根因，不冒充目标现场的唯一根因。

### C3：开书间歇性零派发、无错误、无终态

旧实现缺少一个持久、单一的旅程状态所有者。页面等待状态、任务中心和调用账本可以各自推进；确认、页面离开、超时与调用结算由不同路径竞争，造成：

- 点击后可能只有页面等待，没有可恢复旅程或调用记录；
- 确认后离开页面会丢失恢复入口；
- 发送边界后的未知结果可能被错误取消或再次发送；
- 混合旧批次会被宽松恢复；
- 已拒绝的超时结算承诺被缓存，作者明确重试也无法重新结算。

修复后，从“点击开始创作”起持久保存一条旅程，并让披露、预留、发送边界、最终调用和任务中心使用同一批次、请求及支持标识。模型、连接、路线、能力或隐私快照缺失会立即进入准确失败终态。确认前离开为零发送的“确认前安全终止”；一旦越过发送边界且没有服务商权威结果，无论本机取消返回成功、失败或抛错，都进入“结果待核对”，不把本机取消令牌误当成服务商取消或未计费证明。自动重试次数始终为零，迟到结果保持隔离，重开与重启不会二次发送。

## 三、修复前后行为

| 范围            | 修复前                                     | 修复后                                                                         |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| C2 可选坏记录   | 单条坏候选可使整个编辑器崩溃；重载重复失败 | 保留并隔离坏行，正文与安全候选继续打开；支持编号和脱敏诊断可追踪               |
| C2 权威数据     | 错误边界缺少准确阶段与恢复分级             | 项目、章节、版本不安全时停止写入；提供诊断、备份/恢复和重试                    |
| C3 点击与预检   | 可能只显示等待，任务与调用账本为空         | 点击即持久化旅程；预检缺项立即失败并带支持编号                                 |
| C3 发送边界     | 页面离开、超时、取消可能无终态或错误取消   | 同一调用标识贯穿；发送后未知统一“结果待核对”；零自动重发                       |
| C3 恢复         | 离开页面后挂起消失                         | 页面离开和应用重启后可从旅程、任务中心和调用记录恢复                           |
| B3 自动整理设定 | 能力标记与真实整理不一致；缺少可靠证据范围 | 只从已保存不可变版本本地提取，携带章节、版本、原文证据和准确范围，先进入待确认 |
| B3 并发安全     | 整理期间正文版本变化可能留下过期事实       | 当前版本检查、旧摘要弃用、新草稿和修订记录在同一事务围栏完成                   |
| B6 规划披露     | 空规划或内部状态可能误报“剧情规划未完成”   | 空规划与已有规划均可查看发送信息；真正失败显示阶段、支持编号和恢复动作         |
| P2 续写确认     | 每次确认缺少受控会话复用                   | 作者可主动记住当前会话；九项范围完全一致才复用，仍显示摘要并要求点击           |
| P2 普通中文     | 普通页面暴露内部术语或状态值               | 使用“本次挑选的故事资料”“服务商未提供费用信息”等自然中文                       |
| P2 一句话设定   | 身份、任职、年龄句式可能落入空白技术表单   | 支持所需句式，解析后仍待作者确认；失败保留原句并说明缺项                       |
| P3 编辑动作     | 缩写等入口不完整                           | 扩写、改写、润色、缩写使用真实发送披露和隔离候选，接受前不写正文               |
| P3 历史结果治理 | 长期“等待决定”的结果缺少集中查看和保留动作 | 章节内保留全部正文生成结果；30 天只显示提醒，可查看、继续保留或明确放弃        |
| P3 作品归类     | 测试作品、示例和作者作品混在普通作品库     | 只按显式身份分区；名称和正文不参与判断，系统评测不进入普通作品库               |

## 四、关键修改文件与迁移

### C2 诊断、错误边界与数据隔离

- `apps/desktop/src/infrastructure/ui-route-diagnostics.ts`
- `apps/desktop/src/infrastructure/safe-operation-diagnostics.ts`
- `apps/desktop/src/components/app-error-boundary.tsx`
- `apps/desktop/src/components/desktop-persistence-boundary.tsx`
- `apps/desktop/src/components/component-ownership-context.ts`
- `apps/desktop/src/components/component-ownership-path.tsx`
- `apps/desktop/src/pages/editor-page.tsx`
- `packages/data/src/sqlite-repositories.ts`

### C3 开书旅程与超时结算

- `apps/desktop/src/infrastructure/opening-journey-run.ts`
- `apps/desktop/src/infrastructure/opening-journey-deadline-coordinator.ts`
- `apps/desktop/src/infrastructure/creative-opening-service.ts`
- `apps/desktop/src/pages/idea-journey-page.tsx`
- `apps/desktop/src/pages/task-center-page.tsx`
- `apps/desktop/src/infrastructure/model-hub-execution-service.ts`
- `apps/desktop/src/infrastructure/diagnostics.ts`

### B3、B6 与普通体验

- `apps/desktop/src/infrastructure/direct-story-fact-organizer.ts`
- `apps/desktop/src/infrastructure/story-fact-store.ts`
- `packages/story-core/src/story-fact.ts`
- `packages/story-core/src/story-fact-use-cases.ts`
- `packages/story-core/src/persistence/story-fact-repository.ts`
- `apps/desktop/src/components/story-planning-panel.tsx`
- `apps/desktop/src/infrastructure/model-hub-story-planning-service.ts`
- `apps/desktop/src/infrastructure/continuation-confirmation-session.ts`
- `apps/desktop/src/infrastructure/story-settings-ordinary-language.ts`
- `apps/desktop/src/infrastructure/story-settings-authoring.ts`
- `apps/desktop/src/pages/story-governance-page.tsx`
- `apps/desktop/src/pages/import-journey-page.tsx`
- `apps/desktop/src/components/story-settings-tools.tsx`

### P3 历史生成结果治理

- `apps/desktop/src/components/candidate-history-panel.tsx`
- `apps/desktop/src/infrastructure/candidate-retention-policy.ts`
- `apps/desktop/src/pages/editor-page.tsx`
- `apps/desktop/src/pages/workspace-page.tsx`
- `packages/domain/src/entities/ai-candidate.ts`
- `packages/application/src/use-cases/candidate-use-cases.ts`
- `packages/data/src/sqlite-repositories.ts`

本项没有新增数据库字段。超过 30 天是根据正文生成结果的 `updatedAt` 派生出的提醒，不会自动把结果改成“已失效”，也不会自动接受、放弃或删除。作者选择“继续保留”时，结果仍处于等待决定状态，只刷新 `updatedAt` 并递增 `revision`；SQLite 保存继续使用状态与修订号的 CAS，旧窗口不能覆盖新决定。已放弃和已失效结果只读可见；这些治理动作不修改正文或不可变版本。

### P3 作品显示身份与测试资料隔离

- 数据层：`packages/data/migrations/0077_project_display_identities.sql`、`packages/data/src/project-display-identity-sqlite-repository.ts`、`packages/data/src/sqlite-repositories.ts`、`packages/data/src/maintenance.ts`。
- 桌面端：`apps/desktop/src/infrastructure/development-storage.ts`、`apps/desktop/src/infrastructure/direct-project-display-identity.ts`、`apps/desktop/src/pages/start-page.tsx`、`apps/desktop/src/pages/projects-page.tsx`、`apps/desktop/src/qa/webview-stress-controller.tsx`。
- 应用边界：`packages/application/src/ports/project-repository.ts`、`packages/application/src/use-cases/project-use-cases.ts`。

项目显示身份只保存“作者作品、测试作品、内置示例、系统评测”及内容无关来源，不读取作品名、章节名或正文作判断。旧项目没有身份记录时安全读取为“作者作品／旧数据未记录”；作者作品与测试作品可逆、幂等切换并保留修订历史，内置示例和系统评测受保护。开始页最近创作只列作者作品，示例入口只认精确内置身份，同名作者作品不会被接管。作品库分开“作者作品”和“测试与示例”，系统评测完全隐藏；单条身份附属记录损坏时，作品与正文仍可打开并显示重读提示。

SQLite 创建、导入、开书和内容同步在同一事务内写入项目、初始身份及首条历史；浏览器开发存储在同一次可恢复写入中完成同等提交。任一身份结构只存在一部分时失败关闭并回滚，不留下半个项目。备份恢复合同同时覆盖当前身份和完整修订历史；旧备份只允许两张表同时缺失，只缺一张时拒绝恢复。

### 数据库迁移

- 新增向前迁移：`packages/data/migrations/0076_direct_local_story_fact_author_revision.sql`。
- 新增向前迁移：`packages/data/migrations/0077_project_display_identities.sql`。
- 原生迁移登记：`apps/desktop/src-tauri/src/local_migrations.rs` 中新增迁移序号 79 和 80。
- 没有修改任何已发布迁移或校验值。
- `0076` 不新增表或字段，只收窄本地直接提取事实的作者修订触发器；`0077` 新增内容无关的项目显示身份当前表、不可变修订历史和严格保护触发器，不改动正文、章节或不可变版本。

新增的专项回归还包括：

- `packages/data/tests/direct-local-story-fact-author-revision-migration.test.ts`
- `packages/data/tests/released-v023-continuous-upgrade.test.ts`
- `apps/desktop/src/pages/idea-journey-c3-regression.test.tsx`

## 五、测试证据

### 先红后绿的聚焦回归

| 范围            | 精确命令                                                                                                                                                                                                                                                                           | 修复前                         | 修复后                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------- |
| C2 错误分级     | `pnpm --filter @inkshadow/desktop test -- src/pages/editor-candidate-route.test.tsx -t "keeps正文 open\|fails closed for unsafe immutable versions"`                                                                                                                               | 2 失败、53 跳过                | 2 通过、53 跳过                         |
| C3 持久旅程     | `pnpm --filter @inkshadow/desktop exec vitest run --config vitest.config.ts --configLoader runner src/infrastructure/opening-journey-run.test.ts src/infrastructure/opening-journey-deadline-coordinator.test.ts src/pages/idea-journey-c3-regression.test.tsx --reporter=verbose` | 三个新增回归各 1 项稳定失败    | 3 文件、48 项通过                       |
| B3 权威版本围栏 | `pnpm --filter @inkshadow/desktop test -- src/infrastructure/direct-story-fact-organizer.test.ts -t "does not persist"`                                                                                                                                                            | 2 失败、17 跳过                | 2 通过、17 跳过                         |
| B6 规划披露     | `pnpm --filter @inkshadow/desktop test -- src/components/story-planning-panel.test.tsx`                                                                                                                                                                                            | 4 项新增断言失败               | 32 项通过                               |
| 发送后作者结束  | `pnpm --filter @inkshadow/desktop test -- src/pages/idea-journey-page.test.tsx`                                                                                                                                                                                                    | 旧逻辑把本机取消误当服务商取消 | 68 项通过；本机取消成功、失败、抛错 3/3 |

### 后续 P3 聚焦验证

以下结果属于“历史生成结果治理”后续工作树的聚焦验证，不包含在下方既有完整发布门禁中，也不代表真实安装程序或真实服务商通过：

| 范围                 | 精确命令                                                                                                                             | 结果        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| 领域状态与继续保留   | `pnpm --filter @inkshadow/domain test -- tests/content-entities.test.ts`                                                             | 15／15 通过 |
| 应用用例与修订围栏   | `pnpm --filter @inkshadow/application test -- tests/candidate-use-cases.test.ts`                                                     | 29／29 通过 |
| 历史面板与编辑器路由 | `pnpm --filter @inkshadow/desktop test -- src/components/candidate-history-panel.test.tsx src/pages/editor-candidate-route.test.tsx` | 63／63 通过 |
| 工作台待处理结果投影 | `pnpm --filter @inkshadow/desktop test -- src/pages/workspace-page.test.ts`                                                          | 3／3 通过   |
| SQLite 候选并发保存  | `pnpm --filter @inkshadow/data test -- tests/candidate-revision-concurrency.test.ts`                                                 | 4／4 通过   |
| 桌面端类型检查       | `pnpm --filter @inkshadow/desktop typecheck`                                                                                         | 通过        |

普通模式和专业模式均可从作品工作台看到“待处理生成结果”并进入对应章节；工作台只统计用途为正文且仍等待作者决定的结果，不把方向选项或其他用途混入待办。

### 2026-08-24 作品归类与数据安全聚焦验证

以下结果绑定 2026-08-24 当前增量；它们不是下方 2026-08-23 历史完整门禁，也不代表真实安装或真实服务通过：

| 范围                     | 精确命令                                                                                                                                                                                                                                                                                                                                         | 结果                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| 身份迁移、仓储与安全约束 | `pnpm --filter @inkshadow/data test -- tests/project-display-identity-migration.test.ts tests/project-display-identity-repository.test.ts tests/project-display-identity-classification.test.ts tests/project-display-identity-content-safety.test.ts tests/project-display-identity-creation-schema.test.ts`                                    | 5 个文件，14／14 通过 |
| v0.2.3 连续升级          | `pnpm --filter @inkshadow/data test -- tests/released-v023-continuous-upgrade.test.ts`                                                                                                                                                                                                                                                           | 1 个文件，1／1 通过   |
| 174 表备份恢复           | `pnpm --filter @inkshadow/data test -- tests/maintenance.test.ts -t "restores all supported tables from a healthy backup atomically"`                                                                                                                                                                                                            | 1／1 通过，49 项跳过  |
| 应用层创建身份传递       | `pnpm --filter @inkshadow/application test -- tests/project-use-cases.test.ts`                                                                                                                                                                                                                                                                   | 1 个文件，5／5 通过   |
| 浏览器、直接创建与页面   | `pnpm --filter @inkshadow/desktop test -- src/infrastructure/development-project-display-identity.test.ts src/infrastructure/development-ideation-project-commit.test.ts src/infrastructure/ideation-project-commit.test.ts src/infrastructure/content-sync-materializer.test.ts src/pages/start-page.test.tsx src/pages/projects-page.test.tsx` | 6 个文件，69／69 通过 |
| 桌面端类型检查           | `pnpm --filter @inkshadow/desktop typecheck`                                                                                                                                                                                                                                                                                                     | 通过                  |

### 2026-08-24 当前完整源码与原生层门禁

`pnpm release:check`

- 首次运行在代码规范阶段准确报告 4 个问题，修复后从头重跑；最终退出码为 0。
- 构建：网页端 1616 个模块、桌面端 2300 个模块，均成功。
- 格式检查、凭据扫描、137 项依赖许可、20 个包的架构边界、正式配置、全工作区类型检查和代码规范检查均通过。
- 脚本门禁：39／39 通过。
- 工作区测试：497 个文件通过、16 个外部条件文件跳过；3732 项通过、65 项跳过、0 项失败。

`pnpm check:rust`

- 原生格式检查和严格静态检查通过。
- 原生测试：194 项通过、1 项因需要显式本地模型而忽略、0 项失败；入口测试和文档测试均为 0 项失败。

`pnpm test:e2e:release`

- 未提交工作树上的首次尝试被干净提交前置检查按设计拦下，退出码 1，业务旅程 0 项开始；没有把该环境前置失败记作业务通过或失败。
- 清理并形成干净本地提交后必须从头运行一次；当前尚未执行。

### 2026-08-23 历史总门禁

以下结果只绑定当时的工作树；2026-08-24 增量已经在上方重新运行，当前结论不借用这些历史数字：

`pnpm release:check`

最终结果：

- 构建：网页端 1616 个模块、桌面端 2296 个模块，均成功。
- 格式检查：通过。
- 凭据扫描：通过，0 个凭据模式。
- 依赖许可：137 项通过。
- 架构边界：20 个包通过。
- 发布配置：17 项通过。
- 全工作区类型检查：通过。
- 全工作区代码规范：0 错误、0 警告。
- 全工作区测试：489 个文件通过，16 个云端外部条件文件跳过；3678 项通过、65 项跳过、0 项失败。

为保留真实审计轨迹，本轮总门禁曾依次拦下测试夹具中的疑似凭据、47 个代码规范错误与 3 个警告、4 个陈旧断言，以及最终补丁的一处格式问题；均未放宽规则，逐项修正后从头重跑并得到上述最终结果。

### 原生层

`pnpm check:rust`

- 原生格式检查：通过。
- 严格静态检查（警告视为失败）：通过。
- 原生测试：194 项通过、1 项因需要显式本地模型而忽略、0 项失败。
- 文档测试和入口测试：0 项失败。

### 正式网页端

正式网页候选只能由干净 Git 提交生成。未提交工作树运行 `pnpm --filter @inkshadow/desktop build:web:release` 时按设计失败关闭；形成干净提交后执行：

- `pnpm --filter @inkshadow/desktop build:web:release`：通过；来源 1274 个文件、22137158 字节，SHA-256 `42358bfce9d0a0162e47164f3e5378be59e4ff2132fde90ee7885f572575148c`；产物 59 个文件、7251150 字节，SHA-256 `d2e3cfc065d2218766c5697a785e71b4cf69877b5f3ab7020d0cd43e79d3f0fe`。
- `node scripts/check-desktop-release.mjs --dist apps/desktop/dist-release`：通过，提交来源、生产配置、文件清单和哈希一致。
- `node scripts/run-e2e.mjs --dist apps/desktop/dist-release`：首次因缺少对应 Chromium 运行时，17 项均未进入业务步骤；安装 Playwright 指定的可再生测试运行时后从头重跑，17／17 通过，耗时 32.9 秒。

首次环境失败没有记作业务失败或通过；只有安装匹配运行时后的完整重跑计入最终端到端结果。

## 六、分项状态

| 优先级 | 项目                                                          | 状态                                       |
| ------ | ------------------------------------------------------------- | ------------------------------------------ |
| P0     | C2 可选坏记录隔离、权威数据失败关闭、支持编号与脱敏诊断       | 当前源码自动化验收通过；目标现场复现未取得 |
| P0     | C3 单一持久旅程、统一调用标识、超时/离开/重启恢复、零自动重发 | 自动化验收通过                             |
| P1     | B3 本地证据提取、待确认设定、原子版本围栏、幂等重建           | 自动化验收通过                             |
| P1     | B6 空/已有规划披露与准确失败                                  | 自动化验收通过                             |
| P2     | 当前会话精确确认、普通中文、一句话设定、等待阶段与支持编号    | 自动化验收通过                             |
| P3     | 扩写、改写、润色、缩写真实入口                                | 已实现，真实服务质量未执行                 |
| P3     | 历史“等待决定”结果的提醒、查看、放弃和保留策略                | 已实现并通过完整源码门禁；真机未执行       |
| P3     | 测试作品与普通“未命名新故事”区分                              | 已实现并通过完整源码与原生层门禁           |

## 七、未取得与未执行

### 未取得

- 两轮复测目标现场数据库。
- “橘猫第一章”“深夜电台”的原始诊断、准确错误编号、触发坏行及旧应用/组件调用栈。
- 目标机器日志、任务账本和调用账本导出。
- 目标现场备份与恢复样本。

### 未执行

- 真实服务商、真实凭据、付费模型和真实计费核对。
- 真实安装程序的安装、v0.2.3 至 v0.2.7 连续原地升级、卸载和回滚。
- 真实应用进程强制终止后的真机恢复。
- 目标现场数据库导入复测。
- 1440、1280、1024、800 宽度、深浅主题、键盘路径和系统 200% 缩放的完整人工矩阵。
- 已发布附件替换、推送、打标签和发布；这些操作均未获本轮授权。

模拟网关测试只证明本地状态合同，不标记为真实模型验证。

## 八、剩余风险与下一步

1. 最高剩余风险是缺少目标现场数据库；C2 已有保守隔离和诊断，但不能证明覆盖两个现场项目的唯一坏行组合。
2. 本地取消不能证明服务商取消或未计费，因此发送后未知结果继续需要作者人工核对，不能自动重试。
3. 自动设定整理是确定性本地解析器，只提取有明确文本证据的支持句式；复杂语义可能不提取，但不会猜测或影响正文。
4. 应先用新构建在隔离副本中导入目标现场数据库，导出新的支持编号和脱敏诊断，再做真实安装升级矩阵。
5. 在上述现场验证、真实服务授权测试和人工界面矩阵完成前，不建议发布。以后如发布，必须使用新版本号。

## 九、工作区清理清单

- 临时解压目录、验证日志、测试结果、覆盖率、网页构建、原生编译目录和其他缓存均不纳入 Git。
- 正文证据、源码、迁移、测试和文档保留。
- 最终验证后清理 `.tmp`、各 `dist`／`dist-release`、`coverage`、`test-results`、`playwright-report`、原生 `target` 及工作区依赖目录。
- 清理只针对可重新生成且已确认位于 `D:/InkShadow` 内的目录；不删除作品、数据库、安装包、发布附件或用户提供材料。
