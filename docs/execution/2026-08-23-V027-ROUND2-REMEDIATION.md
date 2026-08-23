# v0.2.7 两轮复测缺陷修复报告

> 日期：2026-08-23  
> 状态：源码、全工作区、原生层和正式网页端自动化门禁通过；尚未发布，现有 v0.2.7 标签、安装包和附件保持不变。  
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

### 数据库迁移

- 新增向前迁移：`packages/data/migrations/0076_direct_local_story_fact_author_revision.sql`。
- 原生迁移登记：`apps/desktop/src-tauri/src/local_migrations.rs` 中新增迁移序号 79。
- 没有修改任何已发布迁移或校验值。
- 本迁移不新增表或字段，只收窄调整触发器，使带证据、待确认的本地直接提取事实能够由作者确认、修改或放弃；正式事实仍须作者动作。

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

### 总门禁

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
| P3     | 历史“等待决定”候选的过期/保留策略                             | 明确延期；没有自动删除历史候选             |
| P3     | 测试作品与普通“未命名新故事”区分                              | 明确延期                                   |

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
