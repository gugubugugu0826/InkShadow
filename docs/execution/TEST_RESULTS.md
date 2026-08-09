# InkShadow 测试与构建结果

> 更新日期：2026-08-09  
> 证据范围：最终发布提交 `435454b952bead1014dd7d44f0f4806d70fce7e5` 已完成本地完整候选链、Windows x64 未签名打包、远端 GitHub Actions 三作业和公开 Pre-release 附件回读校验。下方明确标记为历史的结果不能替代本次证据

## 2026-08-09 当前验证状态

| 范围                            | 结果                                                                                                                   | 状态 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---- |
| 全仓发布预检                    | `pnpm release:check`，439.4 秒；格式、秘密、151 licenses、20 boundaries、17 release tests、20 TS 工作区、ESLint 全通过 | PASS |
| pnpm 11 发布脚本回归            | 17/17；包含真实 CLI 解析、失败关闭、候选步骤、干净检出命令和发布来源/制品校验                                          | PASS |
| GitHub 干净检出修复模拟         | 同时移开 `access-core/dist` 与 Desktop `dist` 后，拓扑构建、20 工作区类型、Cloud 87/64、Node 入口和 Clippy 全通过      | PASS |
| Workspace 自动化                | `2,569 passed / 65 skipped`；跳过项为 64 项真实 PostgreSQL 条件和 1 项真实 Ollama 条件                                 | PASS |
| Desktop 自动化                  | 206 files；`1,420 passed / 1 skipped`                                                                                  | PASS |
| Rust 原生层                     | format、严格 clippy；`147 passed / 1 ignored`                                                                          | PASS |
| 全工作区生产构建                | 20 个可构建工作区全部完成；Desktop 与 Web 均通过                                                                       | PASS |
| Desktop 默认公开前端            | 2,562 modules；82 files；6,325,162 bytes / 6,422,528 bytes；PDF Worker 1,190,087 bytes                                 | PASS |
| Desktop 团队功能双开构建        | 87 files；6,412,787 bytes / 6,422,528 bytes；4 个 Studio 页面均重新进入产物                                            | PASS |
| Desktop production Chromium E2E | `9/9`；生产 PDF Worker 请求与扫描件失败关闭路径已覆盖；DPR2 焦点场景另串行重复 `10/10`                                 | PASS |
| 干净提交候选链                  | 提交 `435454b`；703.9 秒；源码指纹 1,049 文件 / 16,109,230 bytes；全链从头通过                                         | PASS |
| Windows x64 未签名安装包        | 7,429,121 bytes；SHA-256 `6E824533BE5FBBBC2693C8F3891BA2CDD5850B39BA17674C8D1A4EF3E1D2FC20`                            | PASS |
| GitHub Actions                  | run `31289865897`；Cloud PostgreSQL/forced RLS、质量与浏览器、Windows 原生与 NSIS 三作业全部成功                       | PASS |
| GitHub Pre-release              | `v0.2.0`；公开、非 Draft、未签名工程预览；三个附件均从 Release 重新下载并逐项核对                                      | PASS |

公开前端中的 PDF.js Worker 仅出现一份完整 Apache 许可证、`pdfjsVersion = 6.1.200`、
`pdfjsBuild = 6353acefe` 与 `WorkerMessageHandler`；默认构建无 `studio-*` 页面。候选内嵌发布清单为
15,823 bytes，SHA-256 `9CA873E72676DF094AC3B78C2B233CA46AE8ABD32BA339C1868E83FADAF69FAC`；
公开 Release 为 <https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.0>。

### 2026-08-09 发布收口失败记录（不计为通过）

- 首次全工作区构建发现桌面前端 6,478,079 bytes，超过既有 6,422,528 bytes 预算 55,551 bytes。没有提高预算；改为让 PDF Worker 经过 Vite 压缩、裁掉公开版不可达的四个 Studio 页面，并把 OpenAPI 文档生成器移出运行时入口。最终默认构建降为 6,325,162 bytes。
- 体积修复后的第一次 `release:check` 在 ESLint 阶段发现一处 `Array<T>` 风格错误；前置门禁与 20 个工作区类型检查当时均已通过。修正为仓库约定的 `T[]` 后，完整检查从头运行并通过。
- 第一次 E2E 启动被已确认属于 InkShadow 的旧测试服务占用 1420 端口阻止，未进入测试。关闭遗留服务后，真实首轮为 `7/9`：两项失败均为旧断言与新安全流程不一致，页面实际已经正确执行续写插入与 PDF OCR 失败关闭。修正后定向 `2/2` 通过。
- 下一轮 E2E 为 `8/9`，唯一失败是对 `:focus-visible` 动态样式的一次性同步取样；失败截图仍显示正确焦点环。改用 Playwright 可重试样式断言后，DPR2 场景 `10/10`、完整 E2E `9/9` 通过。
- 第一次从唯一提交启动正式候选链时，在进入任何构建步骤前被发布脚本拒绝。根因是 pnpm 11 在该 Windows 运行方式下不再提供脚本原先依赖的 `npm_execpath`，同时旧校验也没有覆盖当前的 `.mjs` CLI；本次尝试没有生成候选包，不能计为通过。发布脚本改为在确认 pnpm 调用身份后安全解析实际 CLI，并补充回归测试；修复将进入新的唯一提交，随后整条候选链从头重跑。
- pnpm 11 修复后的本地候选链在提交 `cad81533cd41ebdafd4fe8b5cc0f32bf102716e7` 上完整通过并生成安装包，但首次 GitHub Actions 干净检出暴露了两项旧环境缺陷，因此该候选不再作为最终发布候选：`access-core` 只指向未提交的 `dist`，使 Cloud 七个测试文件在收集阶段失败、Windows 质量作业出现六项 TS2307；原生作业又在前端 `dist` 尚未生成时运行 Clippy，使 Tauri 上下文宏失败。这七个 Cloud 文件没有进入数据库或业务断言，不能据此判定相关断言通过或失败；其余 30 个文件的 114 项测试通过。最终修复保留可直接运行的 `dist` 包入口，并让本地发布、质量 CI、Cloud CI 和原生 CI 都先按工作区依赖拓扑生成所需入口和前端目录；新提交必须重新执行本地候选链和全部远端 CI。
- 干净检出修复后的本地候选链在提交 `9c142c254babd9dcb9bee1f53b691d112b90a826` 上以 686.8 秒完整通过并生成安装包；GitHub Actions run `31279672549` 证明 Cloud PostgreSQL 与 forced RLS 全部通过，质量和原生作业也已越过先构建、类型与 Clippy 修复点，但暴露两个新的 Windows Runner 环境假设，因此该候选继续作废。质量作业只有两个真实 PDF 集成测试在四工作区并发下超过默认 5 秒；日志与调用顺序指向 PDF.js 冷加载，唯一报告失败类型为超时、未报告断言不匹配，同包其余 65 项通过。修复只为这两项设置 30 秒逐测试上限。原生作业为 `145 passed / 1 failed / 1 ignored`：Windows 管理员 token 创建目录时可默认由 `BUILTIN\Administrators` 持有，旧安全更新代码只写保护 DACL 却随后要求 owner 必须是当前用户。修复在写 ACL 前后都要求 owner 严格属于当前用户、SYSTEM 或 `BUILTIN\Administrators`，并继续要求保护 DACL 恰好只有这三条精确 ACE；陌生 owner 在任何改写前即失败关闭，不跳过测试、不接管目录。新提交仍必须重新执行本地候选链和全部远端 CI。
- 对上述 owner 修复的独立复核又发现旧实现仍按路径分别读取、改写和复核 ACL，存在检查期间替换暂存目录的竞态。最终实现只打开一次非 reparse 的真实目录句柄，ACL 前检、写入、后检与身份记录全部绑定该句柄，并在完整下载、重命名、摘要和过期复核期间持续持有；句柄用最小的 `FILE_LIST_DIRECTORY` 激活 Windows 共享核对且不共享删除权限。Windows 对抗测试已证明 guard 存活时同一目录不能重命名或删除、释放后同一操作成功；另一测试用拒绝 owner 策略并逐字节快照 DACL，证明陌生 owner 在任何 DACL 写入前失败。该定向套件 `8/8`、本地完整 Rust `147 passed / 1 ignored`；仍需由新干净提交的正式候选链与远端 Windows Runner 重新确认。
- 本地候选链随后在提交 `36441bbd5a566506aa6913d3f5f7a5224cccd505` 上以 704.7 秒完整通过，但 GitHub Actions run `31283869052` 的质量作业又暴露一项独立的 Windows Runner 时序假设，因此该候选同样作废。Cloud PostgreSQL/forced RLS 与 Windows 原生作业全部通过；质量作业的构建、类型和 lint 通过，唯一失败是一个真实临时文件 SQLite 双连接 `BEGIN IMMEDIATE` 锁测试用时 5.063 秒，超过 Vitest 默认 5 秒，未报告断言不匹配；同文件其余 11 项、同包其余 132 项通过。由于测试阶段失败，浏览器旅程未执行，不能把该远端 run 记为全绿。修复只为这一项真实 SQLite 集成测试设置 30 秒逐测试上限，不修改全局超时或生产事务逻辑；新提交必须再次从头执行本地候选链和全部远端 CI。
- SQLite 单项时限修复后的本地候选链在提交 `02c81e1bc22f360441d6d216565c34d4b6aec6a7` 上以 700.7 秒完整通过；GitHub Actions run `31285740826` 的 Cloud PostgreSQL/forced RLS 与 Windows 原生作业也全部通过，原生作业包含 Rust format、严格 Clippy、`147 passed / 1 ignored`、发布前端演练和未签名 NSIS 打包。质量作业的构建、类型和 lint 通过，Story Core 的 SQLite 测试亦已通过；唯一失败是 Desktop 的旧版 What-if 只读历史页面跳转测试，1.544 秒总耗时与路由结构表明首次懒加载“故事关联”页面未能在 Testing Library 默认约 1 秒查询等待内完成，日志只报告找不到目标标题，Desktop 同轮其余 `1,419 passed / 1 skipped`。由于测试阶段失败，浏览器旅程仍未执行，不能把该 run 记为全绿。修复只为这条真实跨路由测试设置 10 秒元素等待和 15 秒逐测试上限，不修改全局超时、页面导航或生产逻辑；新提交仍须重新执行完整本地候选链和全部远端 CI。
- 跨路由等待修复后的本地候选链在提交 `7675ffde81e45fe250354e4f1d9a4c3f1ed81768` 上以 702.5 秒完整通过并生成安装包；GitHub Actions run `31287548847` 的 Cloud PostgreSQL/forced RLS 与 Windows 原生作业全部通过，原生作业再次完成 Rust format、严格 Clippy、`147 passed / 1 ignored`、发布前端演练和未签名 NSIS 打包。质量作业的构建、类型和 lint 通过，但 Data 包有两个互不相关的真实磁盘 SQLite 用例同时触发 Vitest 默认 5 秒上限：双连接 Candidate revision 权威测试与向量索引落盘关闭重开测试；日志未报告断言不匹配，同包其余 `354` 项通过。两文件在上一成功 run 分别为 919 毫秒和 726 毫秒，本轮文件总耗时均约 8 秒，符合 Windows Runner 与四工作区并发下同步临时文件 I/O 尖峰。由于测试阶段失败，浏览器旅程仍未执行，不能把该 run 记为全绿。审计新增的 15 秒辅助测试入口严格限定到 Data 包 9 项真实磁盘 SQLite/备份/关闭重开用例，以及 Desktop 复用同一文件执行器的 1 项因果图重开测试；内存 SQLite、普通单元测试、Data 包及全仓全局超时仍保持 5 秒，Story Core 已有的文件锁测试继续使用其独立 30 秒上限。修复后的 Data 包 `62/62 files / 356/356 tests` 与类型、格式、lint 均通过；新提交仍须从头执行完整本地候选链和全部远端 CI。
- 最终提交 `435454b952bead1014dd7d44f0f4806d70fce7e5` 仅把上述 15 秒辅助入口应用到经两次独立审查确认的 10 项真实文件 SQLite/备份/关闭重开用例；普通内存测试和全局 5 秒上限未放宽。本地候选链以 703.9 秒完整通过；GitHub Actions run `31289865897` 的 Cloud、质量/浏览器和 Windows 原生三作业全部成功，随后同一提交生成的安装包、发布清单与两行校验表已发布并从公开 Release 重新下载核对。

下面的 2026-08-08 结果保留为可追溯历史，不再称为当前工作树的最终结果。

### 2026-08-09 首次全量门禁（失败，不计为通过）

`pnpm release:check` 首次运行在 Desktop 全量测试阶段退出码为 1。此前格式、秘密扫描、
151 项运行时依赖许可证、20 包架构边界、11 项 Node 发布配置测试、20 个 TypeScript 工作区
与全仓 ESLint 均已通过；Workspace 测试为 `2,566 passed / 1 failed / 65 skipped`，其中
Desktop 为 `206 files / 1,418 passed / 1 failed / 1 skipped`。

唯一失败来自 `continuous-story-state-projection-adapter.test.ts`：旧断言仍要求 `force`
重新处理同一已有精确回执的不可变版本，与“强制重试也不得重复付费派发”的新合同冲突。
修正后的测试先验证旧版本返回 `already_processed / 0`，再创建新不可变版本继续验证 4 项
投影；相关连续状态测试随后 `12/12` 通过。该定向通过不替代下一次完整门禁，最终状态继续
保持 `NOT_RUN`，直到全量从头复跑成功。

## 2026-08-08 P33 Candidate 修订权威与并发保护增量证据

| 范围                                                                  | 命令                                                                                                                                                                                                                                                                                                                                                                                                                                         |                       结果 | 状态 |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------: | ---- |
| Domain Candidate 单调 revision、旧快照兼容、溢出失败关闭              | `..\..\node_modules\.bin\vitest.cmd run tests\content-entities.test.ts`（在 `packages/domain`）                                                                                                                                                                                                                                                                                                                                              |          1 file；12 passed | PASS |
| Application 修改/接受/拒绝、旧界面竞争、哈希篡改、整章策略边界        | `..\..\node_modules\.bin\vitest.cmd run --config vitest.config.ts --configLoader runner tests\candidate-use-cases.test.ts tests\content-use-cases.test.ts`（在 `packages/application`）                                                                                                                                                                                                                                                      |         2 files；36 passed | PASS |
| SQLite 前向迁移、真实双连接竞争、事务回滚、Multi-Agent 章节 Candidate | `..\..\node_modules\.bin\vitest.cmd run --config vitest.config.ts --configLoader runner tests\candidate-revision-migration.test.ts tests\candidate-revision-concurrency.test.ts tests\sqlite-repositories.test.ts tests\sqlite-sync-projection-commits.test.ts tests\multi-agent-review-sqlite-store.test.ts`（在 `packages/data`）                                                                                                          |         5 files；46 passed | PASS |
| SQLite 完整迁移与备份恢复维护链                                       | `..\..\node_modules\.bin\vitest.cmd run --config vitest.config.ts --configLoader runner tests\maintenance.test.ts tests\migration.test.ts`（在 `packages/data`）                                                                                                                                                                                                                                                                             |         2 files；13 passed | PASS |
| Desktop 双窗口开发存储、原子 trace 输出、真实接受链和编辑器路由       | `..\..\node_modules\.bin\vitest.cmd run --config vitest.config.ts --configLoader runner src\infrastructure\development-candidate-concurrency.test.ts src\infrastructure\context-trace-output-commit.test.ts src\infrastructure\core-creative-loop.integration.test.ts src\pages\editor-candidate-route.test.tsx`（在 `apps/desktop`）                                                                                                        |         4 files；13 passed | PASS |
| Tauri 正式本地迁移链                                                  | `cargo test local_migrations --lib`（在 `apps/desktop/src-tauri`）                                                                                                                                                                                                                                                                                                                                                                           | 5 passed；142 filtered out | PASS |
| Domain / Application / Data / Desktop TypeScript                      | 四个工作区各自运行 `typecheck`                                                                                                                                                                                                                                                                                                                                                                                                               |                    0 error | PASS |
| 本轮相关 TS/TSX 文件 ESLint                                           | `node_modules\.bin\eslint.cmd <本轮 25 个实现与测试文件>`                                                                                                                                                                                                                                                                                                                                                                                    |        0 error / 0 warning | PASS |
| Desktop Candidate、导入与 Model Hub 创作链合并复跑                    | `..\..\node_modules\.bin\vitest.cmd run --config vitest.config.ts --configLoader runner src\infrastructure\development-candidate-concurrency.test.ts src\infrastructure\context-trace-output-commit.test.ts src\infrastructure\core-creative-loop.integration.test.ts src\infrastructure\model-hub-creative-chain-integration.test.ts src\pages\import-journey-page.test.tsx src\pages\editor-candidate-route.test.tsx`（在 `apps/desktop`） |         6 files；38 passed | PASS |

本轮为每个 Candidate 增加从 `ready` 阶段开始生效的单调 revision。保存修改、接受和拒绝都必须携带作者实际看到的 revision；SQLite、浏览器开发存储和 Multi-Agent 章节建议都以 `status + revision` 做第二次条件写入。接受前重新计算并核对数据库中 Candidate 正文的 SHA-256；接受时附带的编辑文本重新计算新哈希。整章改写只允许覆盖全文，或在当前正文与基线正文共同的 UTF-16 章末追加；中间插入、选区替换、`accept_all` 和 `apply_changes` 均失败关闭。导入试改、逐章接受和全部接受已改为提交持久化的精确 revision，并显式使用 `overwrite_document`。

新增前向迁移为 Data `0050_candidate_revision_authority.sql` / Tauri `53`；当前迁移总上限随后由并行 Model Hub 工作推进到 Data `0051` / Tauri `54`，未改写已发布迁移。真实双连接测试证明：客户端 A 保存 revision 2 后，客户端 B 基于 revision 1 的修改和接受都会返回 `VERSION_CONFLICT`，且赢家 Candidate、稳定正文和不可变版本不变；直接篡改 Candidate 行正文但不更新哈希时，接受同样回滚为零稳定修改。

合并复跑前曾有一次共享工作树暂态失败：`model-hub-creative-chain-integration.test.ts` 13 项、`import-journey-page.test.tsx` 1 项在 Candidate 操作前返回 `MODEL_HUB_PREFLIGHT_FAILED`。根因为并行 Model Hub 严格凭据引用改动后，测试夹具仍使用旧 `keyring:test:*` 引用；夹具改为允许的 `keyring:model-hub:*` 后，上述两文件先单独 25/25 通过，随后六文件合并 38/38 通过。该模拟链证据仍不能外推为真实供应商已验收。

独立安全复核随后补齐三处遗漏：证据修正与多智能体章节审查的完整章 Candidate 均显式写入
`whole_chapter_rewrite` 意图；旧导入批次缺少 Candidate revision 时，单章和整批重生成都在模型
派发前停止；新批次的 Candidate 指针与 revision 同步写入 localStorage，写失败会保留当前页可见
建议、保留 pending 请求标记并停止余下付费派发。`evidence-correction-candidate.test.ts` 与
`import-journey-page.test.tsx` 合计 10/10 通过；`multi-agent-review-sqlite-store.test.ts` 15/15
通过；Desktop 与 Data typecheck 均为 0 error。持久化故障测试证明两章批次只派发第一章，第二章
保持 0 Candidate，且第一章建议仍可从当前页进入差异处理。

## 2026-08-08 P33 建议编辑与任务语义应用历史增量证据

| 范围                                                       | 命令                                                                                                                                                                                                                                                                                    |                       结果 | 状态 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------: | ---- |
| Application Candidate 编辑、拒绝、锚点应用、冲突与事务回滚 | `pnpm.cmd --filter @inkshadow/application exec vitest run tests/candidate-use-cases.test.ts tests/content-use-cases.test.ts --config vitest.config.ts`                                                                                                                                  |         2 files；25 passed | PASS |
| Domain Candidate 意图校验与兼容读取                        | `pnpm.cmd --filter @inkshadow/domain exec vitest run tests/content-entities.test.ts`                                                                                                                                                                                                    |          1 file；10 passed | PASS |
| SQLite 前向迁移、重开持久化与事务回滚                      | `pnpm.cmd --filter @inkshadow/data exec vitest run tests/candidate-application-intent-migration.test.ts tests/sqlite-repositories.test.ts --config vitest.config.ts`                                                                                                                    |         2 files；20 passed | PASS |
| Desktop 编辑、重开恢复、应用按钮、三方冲突与原子输出关联   | `pnpm.cmd --filter @inkshadow/desktop exec vitest run src/app.test.tsx src/pages/editor-candidate-route.test.tsx src/infrastructure/context-trace-output-commit.test.ts --config vitest.config.ts --configLoader runner`                                                                |         3 files；38 passed | PASS |
| Desktop 真实创作链合同                                     | `pnpm.cmd --filter @inkshadow/desktop exec vitest run src/infrastructure/core-creative-loop.integration.test.ts src/infrastructure/model-hub-creative-chain-integration.test.ts src/infrastructure/native-model-gateway-client.test.ts --config vitest.config.ts --configLoader runner` |         3 files；34 passed | PASS |
| Tauri 正式本地迁移链                                       | `cargo test local_migrations --lib`（在 `apps/desktop/src-tauri`）                                                                                                                                                                                                                      | 5 passed；142 filtered out | PASS |
| Domain / Application / Data / Desktop TypeScript           | 各工作区 `typecheck`                                                                                                                                                                                                                                                                    |                    0 error | PASS |

本轮把续写与选区改写从“保存整个合成章节”改为“保存任务片段和精确 UTF-16 锚点”。作者可先保存对建议的修改，重开后继续；只有显式应用才创建新不可变版本。片段只能按原任务位置应用，整章改写明确提供替换、追加、另存草稿和取消；基线冲突、错误策略、哈希失败和事务故障都保持正文、版本历史和待处理 Candidate 不变。SQLite 前向迁移 `0048_candidate_application_intents.sql` 为旧记录保留完整文档兼容默认值，并用约束与不可变触发器保护新任务语义。

本节不把浏览器开发存储或模拟网关当作真实供应商验收。Candidate 专属 SQLite 迁移与仓库用例另有 `candidate-application-intent-migration.test.ts` 和 `sqlite-repositories.test.ts`；全备份维护套件在并行工作树新增 `0049_memory_governance_audit.sql`、但其测试夹具尚未同步时曾出现 1 项共享暂态失败，因此不在本节伪报全量维护通过，待 `0049` 所属任务合并后统一复核。

## 2026-08-08 上下文精确追溯增量证据

| 范围                                                | 命令                                                                                                                                                                                                                                                                                                                                   |                       结果 | 状态 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------: | ---- |
| Desktop 存储、原子输出提交、运行时链路与参考记录 UI | `pnpm.cmd --filter @inkshadow/desktop exec vitest run --config vitest.config.ts --configLoader runner src/infrastructure/context-trace-output-commit.test.ts src/infrastructure/context-compilation-trace-store.test.ts src/components/context-history-panel.test.tsx src/infrastructure/model-hub-creative-chain-integration.test.ts` |         4 files；35 passed | PASS |
| SQLite 备份恢复                                     | `pnpm.cmd exec vitest run --config vitest.config.ts --configLoader runner tests/maintenance.test.ts`（在 `packages/data`）                                                                                                                                                                                                             |           1 file；8 passed | PASS |
| Data 与 Desktop TypeScript                          | `pnpm.cmd --filter @inkshadow/data typecheck`；`pnpm.cmd --filter @inkshadow/desktop typecheck`                                                                                                                                                                                                                                        |                    0 error | PASS |
| Tauri 本地迁移链                                    | `cargo test local_migrations --lib`（在 `apps/desktop/src-tauri`）                                                                                                                                                                                                                                                                     | 5 passed；142 filtered out | PASS |

本轮只证明受控 SQLite、浏览器开发存储和模拟 Model Hub 链路：trace 可精确关联真实
`generationId`、generation run、Model Hub invocation 和最终隔离 Candidate，旧浏览器 v1 记录可读，
编译器输入 ID 不会被当成 AI Candidate ID。真实 SQLite 故障注入已覆盖 Candidate INSERT 成功后、
输出关联写入前失败，验证整笔 transaction 回滚为 0 Candidate / 0 link；完全相同重试只保留一份，
同 ID 不同内容则失败关闭。运行时失败测试确认选区改写和直接续写不会改变稳定正文，也不会留下
可接受 Candidate。它不代表真实云供应商或安装包矩阵已经验收。

## 2026-08-08 最终产品重构候选证据

| 范围                        |                           最终结果 | 状态 | 说明                                                                                                                                        |
| --------------------------- | ---------------------------------: | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 全仓发布检查                |                 391.9 秒，退出码 0 | PASS | Prettier、秘密扫描、151 项运行时依赖许可证、20 包边界、9 项 Node 发布测试、20 个 TypeScript 工作区、全仓 ESLint 与所有 workspace 测试通过。 |
| Workspace 自动化            |           2,379 passed、65 skipped | PASS | 65 项均为显式外部环境条件：Cloud PostgreSQL 64 项、真实本地 Ollama 1 项；跳过项不计为通过。                                                 |
| Desktop                     | 199 files；1,282 passed、1 skipped | PASS | 0 failed；百万字内存搜索 hot p95 27.77 ms，FTS5 hot p95 0.33 ms。                                                                           |
| Data                        |               55 files；339 passed | PASS | 包含 migration `0045`、136 张应用持久表、135+1 恢复边界和远程派发租约竞态。                                                                 |
| Story Core                  |               22 files；129 passed | PASS | 覆盖权威事实、证据、因果、POV/知识取得和双连接事务互斥。                                                                                    |
| Import/Export               |                 8 files；67 passed | PASS | 现代 WebView PDF.js 与 Node legacy 回退、损坏/主动内容/扫描件/中断边界均通过。                                                              |
| 正式前端                    |          83 files；6,239,149 bytes | PASS | 818 个源输入文件指纹与发布清单一致；产物完整性门禁通过；低于 6 MiB 有效载荷预算。                                                           |
| Desktop production Chromium |                                5/5 | PASS | 三入口、本地项目生命周期、自动保存/崩溃恢复、Candidate 隔离、导入导出与凭据边界通过。                                                       |
| Rust                        |              146 passed、1 ignored | PASS | `cargo fmt --check` 与严格 `cargo clippy --all-targets --all-features -- -D warnings` 同时通过；ignored 为真实 Ollama 条件。                |
| Tauri/NSIS                  |                v0.2.0 x64 unsigned | PASS | 安装包 7,404,796 bytes；主程序为 `Windows GUI (2)`；两者 Authenticode 均为 `NotSigned`。                                                    |

最终候选：`archive/2026-08-08-v0.2.0-product-rebuild-candidate/artifacts/墨影 InkShadow_0.2.0_x64-setup.exe`，SHA-256 `99D8EB731F6DF16F5DAEA05BB7AC9D640D1498B19853F45776CD30A1BB36912A`。

候选复制和摘要复核完成后，已删除 13.062 GiB 的可再生成 Rust/Tauri `target` 构建缓存；旧 `.tmp` 与 Playwright 报告整体移入候选归档。当前项目总量约 0.554 GiB，归档安装包、原生程序、发布清单与源码基线仍完整保留。

未运行且不得外推为完成：商业代码签名、真实云供应商全矩阵、隔离 Windows 首装/覆盖升级/卸载/重装、百万字真实作品压力、长时中文 IME、法律审批与独立安全审计。

## 2026-08-08 POV 知识取得与因果事实原子写入增量证据

- Story Core 包级测试：22 files、129/129 通过。SQLite 持久化覆盖精确来源章节/不可变版本/证据片段、事实类型与结构化 schema、关系端点、事件人物并集、正式人物身份、相同提交恢复，以及真实双连接下 `BEGIN IMMEDIATE` 对竞争写入的互斥。
- Desktop 定向测试：`story-fact-store.test.ts`、`causal-fact-authoring-service.test.ts` 与 `causal-fact-authoring-panel.test.tsx`，3 files、22/22 通过。Browser 开发适配器与 SQLite 使用同一失败关闭规则；投影或页面刷新失败只显示“已保存、等待刷新”，不会把已落库事实误报为保存失败。
- 人物参与者和知情者各最多 128 个，明确知识最多 128 条；事务栅栏的去重引用总量最多 512。结构化事实仍受 SQLite 对齐的 16 KiB 上限约束，超过时在持久化前给出“拆成两个事件”的可操作提示。
- `@inkshadow/story-core` 与 `@inkshadow/desktop` 类型检查均通过；本组相关实现和测试 ESLint 为 0 error / 0 warning。

本轮精确命令：

- `pnpm.cmd --filter @inkshadow/story-core typecheck`
- `pnpm.cmd --filter @inkshadow/story-core test -- story-fact-persistence.test.ts`（包级执行：22 files、129 passed）
- `pnpm.cmd --filter @inkshadow/desktop typecheck`
- 在 `apps/desktop` 执行 `pnpm.cmd exec vitest run --config vitest.config.ts src/infrastructure/story-fact-store.test.ts src/infrastructure/causal-fact-authoring-service.test.ts src/components/causal-fact-authoring-panel.test.tsx`（3 files、22 passed）
- `pnpm.cmd exec eslint packages/story-core/src/story-fact.ts packages/story-core/src/safety.ts packages/story-core/src/persistence/story-fact-repository.ts packages/story-core/tests/node-sqlite-executor.ts packages/story-core/tests/story-fact-persistence.test.ts apps/desktop/src/infrastructure/story-fact-store.ts apps/desktop/src/infrastructure/story-fact-store.test.ts apps/desktop/src/infrastructure/causal-fact-authoring-service.ts apps/desktop/src/infrastructure/causal-fact-authoring-service.test.ts apps/desktop/src/components/causal-fact-authoring-panel.tsx apps/desktop/src/components/causal-fact-authoring-panel.test.tsx --max-warnings 0`（0 error / 0 warning）

> 该增量运行当时的发布结论为 `IN_PROGRESS`；其后的最终工程候选结论以本页首节为准。

## 2026-08-08 历史章节阶段级补缺与恢复增量

| 范围                                                                            | 命令                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |                                                                                                                                            结果 | 状态         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------: | ------------ |
| Desktop 管线、worker、回填服务、摘要去重、任务中心立即重试与 UI                 | `pnpm.cmd exec vitest run apps/desktop/src/infrastructure/accepted-chapter-pipeline.test.ts apps/desktop/src/infrastructure/accepted-chapter-pipeline-worker.test.ts apps/desktop/src/infrastructure/historical-chapter-backfill-service.test.ts apps/desktop/src/infrastructure/chapter-summary-service.test.ts apps/desktop/src/components/chapter-summary-panel.test.tsx apps/desktop/src/pages/task-center-page.test.tsx --config apps/desktop/vitest.config.ts --configLoader runner` |                                                                                                                              6 files，38 passed | PASS         |
| 当前终态/延期 outcome、真实前置门禁、立即重试崩溃恢复与 revalidate→enqueue 竞态 | `node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts --configLoader runner apps/desktop/src/infrastructure/accepted-chapter-pipeline.test.ts apps/desktop/src/infrastructure/accepted-chapter-pipeline-worker.test.ts apps/desktop/src/infrastructure/historical-chapter-backfill-service.test.ts apps/desktop/src/infrastructure/chapter-summary-service.test.ts apps/desktop/src/infrastructure/continuous-story-state-extraction.test.ts`                           |                                                                                                                              5 files，55 passed | PASS         |
| Task Engine 重试与失败原因保存                                                  | `pnpm.cmd --filter @inkshadow/task-engine test`                                                                                                                                                                                                                                                                                                                                                                                                                                            |                                                                                                                              3 files，16 passed | PASS         |
| Task Engine TypeScript                                                          | `pnpm.cmd --filter @inkshadow/task-engine typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                                       |                                                                                                                                         0 error | PASS         |
| 本组相关文件 ESLint                                                             | `pnpm.cmd exec eslint <本组 14 个 TS/TSX 实现与测试文件> --max-warnings 0`                                                                                                                                                                                                                                                                                                                                                                                                                 |                                                                                                                             0 error / 0 warning | PASS         |
| Desktop TypeScript（该次并行工作树快照）                                        | `pnpm.cmd --filter @inkshadow/desktop typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                                           | `dispatchScope` 合同、因果事实 authoring/store 等并行改动当时仍有编译错误；本组文件未出现在错误清单。该历史失败已由本页上方当前复核的 PASS 取代 | FAIL（历史） |

本组覆盖：旧任务兼容；摘要/设定开关从关闭到开启后只补缺失阶段；等待重试只重跑失败阶段；
重试耗尽保留阶段掩码并按补充代数恢复；严格拒绝损坏/越权阶段掩码和非布尔阶段开关；
`already_processed` 作为完成证据；当前摘要不重复调用模型；批量登记中途失败返回准确 `stale`/`partial`
回执；界面显示已登记和剩余数量；阶段补充任务仍受历史 worker 单轮最多 5 条约束。当前新增证据区分
`not_applicable` 与 `deferred`：空章节、来源过大、来源/隐私已变化和版本不存在永久结清绑定版本，
不会自动重试或逐代补建；自动摘要暂停同样不自动重试，恢复后仅在新的显式计划确认中补建；真实供应商
不可用和临时错误仍可重试。v1/v2 outcome 均严格校验规范顺序、唯一性、任务启用范围，空范围任务失败关闭。
混合结果会把失败阶段与 `not_applicable`/`deferred` 一起写入规范 v2 failure evidence；因此任务等待重试、
清除普通 progress 或最终耗尽后，历史回填仍能区分永久覆盖和待显式补建，不会把延期阶段误判成完成。

revalidate→enqueue 竞态测试同时开启摘要与连续故事状态。最后一次复核后若作者立即保存新版本，旧任务
可以准确登记为 `completed`，但两个模型阶段在发送前以 `not_applicable` 结清，模型网关保持 0 调用；
搜索只收录新正文并排除旧正文，因果投影只纳入当前正式、已确认、未废弃的权威事实；当前正文与旧不可变
版本均不改变。
该实现复用现有任务表和元数据，不新增 SQLite 迁移。真实供应商、超大旧书吞吐和跨进程并发仍需外部验收。

## 2026-08-08 AI 剧情规划选择性采纳增量

| 范围                           | 命令                                                                                                                                                                                                                                                               |                结果 | 状态 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------: | ---- |
| Desktop 服务、浏览器存储与页面 | `pnpm.cmd exec vitest run --config vitest.config.ts --configLoader runner src/infrastructure/story-planning-candidate-store.test.ts src/infrastructure/model-hub-story-planning-service.test.ts src/components/story-planning-panel.test.tsx`（在 `apps/desktop`） |  3 files；17 passed | PASS |
| SQLite 迁移与恢复维护          | `pnpm.cmd exec vitest run --config vitest.config.ts tests/story-planning-candidates-migration.test.ts tests/maintenance.test.ts`（在 `packages/data`）                                                                                                             |  2 files；11 passed | PASS |
| Tauri 本地迁移链               | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml local_migrations::tests::migrates_a_fresh_database_and_reuses_the_existing_history -- --exact`                                                                                                       |            1 passed | PASS |
| Desktop TypeScript             | `pnpm.cmd --filter @inkshadow/desktop typecheck`                                                                                                                                                                                                                   |             0 error | PASS |
| 本次改动聚焦 ESLint            | `pnpm.cmd exec eslint <本次 TS/TSX 测试与实现文件> --max-warnings 0`                                                                                                                                                                                               | 0 error / 0 warning | PASS |

本次证据覆盖固定结构化条目的部分采纳、空选择不写入、无关大纲修订冲突、重复同一选择不重复追加、浏览器旧记录兼容、SQLite 新列约束和页面勾选交互。它不证明模型会把条目自动映射为真实书/卷/章子节点；当前实现只对不可变候选 JSON 做字段/行级选择，并通过一次 CAS 更新目标节点简介。

## 2026-08-08 09:00 历史完整运行

| 范围                        |                                                                       结果 | 状态    | 说明                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------: | ------- | ------------------------------------------------------------------------------------------------------------- |
| Desktop 默认全套            |                                         191 files；1,164 passed、1 skipped | PASS    | 0 failed；唯一跳过为需显式本地 Ollama 的真实提取测试。百万字内存搜索 hot p95 42.60 ms，FTS5 hot p95 0.14 ms。 |
| Workspace TypeScript        |                                                                20 projects | PASS    | 所有声明 typecheck 的工作区项目通过。                                                                         |
| Phase 1/接受链聚焦          |                                                 45/45、26/26、93/93、17/17 | PASS    | 分别覆盖派生管线与恢复、ProjectSeed 上下文、ESLint 修复组，以及 P08–P10 快捷连接/开书；集合存在重叠，不相加。 |
| 非 Desktop workspace        |                           19 projects；1,071 passed、64 skipped；19 builds | PASS    | 178 个测试文件通过；cloud-api 的 16 个文件按外部环境配置跳过。                                                |
| Rust                        |                                                      127 passed、1 ignored | PASS    | format 与 `clippy -D warnings` 同时通过；ignored 为显式真实 Ollama 条件。                                     |
| 安全与发布配置              | secrets、151 licenses、20 boundaries、9 Node release tests、release config | PASS    | 没有凭据模式；生产配置门禁通过。                                                                              |
| 全仓 ESLint                 |                                                        0 error / 0 warning | PASS    | P08–P10 合并后从仓库根目录完整复跑。                                                                          |
| 发布前端                    |                          2,550 modules；81 payload files / 6,284,151 bytes | PASS    | 另有 15,512 bytes 发布清单；production artifact gate 通过。                                                   |
| Desktop production Chromium |                                                                        5/5 | PASS    | 使用本轮正式静态构建；契约已同步三入口首页、作品库状态、示例 Candidate 和回收站流程。                         |
| Tauri/NSIS                  |                                                        v0.2.0 x64 unsigned | PASS    | 安装包 7,333,212 bytes；主程序 PE Subsystem 为 `Windows GUI (2)`。                                            |
| 真实供应商/百万字/安装矩阵  |                                                                          — | NOT_RUN | 需要外部凭据、目标数据或隔离 Windows 环境。                                                                   |

上述数字只描述当时命令对应的测试集合，不代表后来继续变化的当前工作树。真实供应商和目标环境验证完成前，不能把工程自动化
通过写成正式发布验收。

该次历史候选原生成路径：`apps/desktop/src-tauri/target/release/bundle/nsis/墨影 InkShadow_0.2.0_x64-setup.exe`（该可再生成构建缓存现已清理）；
生成时间 `2026-08-08 09:00:16 +10:00`；大小 `7,333,212 bytes`；SHA-256
`4425B8E7B5E18B76B63E93481D3CA2D1251FF873990545DFB753672B8DC6571B`；FileVersion /
ProductVersion `0.2.0`；Authenticode `NotSigned`。原生程序为 `24,635,392 bytes`，SHA-256
`E91B57BE79769594F884E35981FB97FEDE6A1ED2CDF08B50896C0BC91D42DAC7`，PE Subsystem
`Windows GUI (2)`。

源码基线为 799 文件 / 12,195,475 bytes，指纹
`1ded2bb88ab757c87a8e641166ecc04762edc2521d4714cb2e39f2c21b15375a`；正式前端有效载荷为
81 文件 / 6,284,151 bytes，指纹
`abb51e4fbafe3ad5b21cb139b356b599f7994909c4da1e5a59c0e2490f16f8d7`。发布清单单独占用
15,512 bytes，不计入 6 MiB 前端有效载荷预算，但受独立 32 KiB 上限约束。

## 2026-08-02 v0.2.0 历史完整证据

| 范围                        |                                                                                              结果 | 状态    | 说明                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------: | ------- | -------------------------------------------------------------------------------- |
| 发布检查                    | format、secret、151 licenses、20 boundaries、release config、20 workspace TypeScript、全仓 ESLint | PASS    | 所有 workspace 测试也已通过。                                                    |
| Desktop 默认全套            |                                                                173 files；1,061 passed、1 skipped | PASS    | 跳过项保持显式，不计作通过。                                                     |
| Data                        |                                                                                        319 passed | PASS    | 包括 v0.2.0 新迁移与 Model Hub 备份恢复范围。                                    |
| Story Core                  |                                                                                        118 passed | PASS    | StoryFact、因果、声纹/POV、叙事和验证合同。                                      |
| Web Guest                   |                                                                                         33 passed | PASS    | 本地加密 Guest 路径。                                                            |
| Rust                        |                                                                             116 passed、1 ignored | PASS    | `cargo fmt --check` 与严格 clippy 同时通过；ignored 为显式本地 Ollama 外部条件。 |
| 发布前端                    |                                                                             978 modules；76 files | PASS    | release artifact gate 通过。                                                     |
| Desktop production Chromium |                                                                                               5/5 | PASS    | 使用正式静态构建。                                                               |
| Tauri/NSIS                  |                                                                               v0.2.0 x64 unsigned | PASS    | 构建与归档摘要一致。                                                             |
| 隔离 Windows 安装矩阵       |                                                                                                 — | NOT_RUN | 首装、旧版覆盖升级、卸载保留、重装和恢复仍未执行。                               |
| 真实供应商/百万字矩阵       |                                                                                                 — | NOT_RUN | 本地与模拟合同测试不得外推为真实服务和长篇性能验收。                             |

候选路径：`archive/2026-08-01-v0.2.0-candidate/artifacts/墨影 InkShadow_0.2.0_x64-setup.exe`；
大小 `7,179,887 bytes`；SHA-256
`AA4C4C2EDFFB29B810B2BBAFBBF4484DAD2A20EED98BD8708F28E018D5DE856A`；FileVersion /
ProductVersion `0.2.0`；Authenticode `NotSigned`。原生程序为 `24,229,888 bytes`，SHA-256
`7E0E206DB0577C044D26395FD54F0B7413A23B1719DAEFE60A6B211DE1B51E0E`，PE Subsystem
`Windows GUI (2)`。

源码基线为 756 文件 / 11,492,637 bytes，指纹
`b564f004b53f78ca5e0efc61e0e4629d2811be7c7645e1077ea6d7cb7123e1dc`；正式前端为
76 文件 / 6,058,291 bytes，产物指纹
`e192ef5e746ca1e343f29cfa54a8c4e410f2d550f38ffb9c496b27e5779b2ced`。

首次候选链已通过格式、秘密、许可证、边界、发布配置、类型、lint 和 workspace 测试，随后
在前端产物门禁因 inline favicon 的 SVG namespace 误报而停止。改为本地 favicon 后，最终重新
通过格式、秘密、lint、`git diff --check`、production build、artifact gate、E2E 与
Tauri/NSIS 打包；失败运行没有被记为 PASS。

## 2026-07-31 页面细节整改增量（历史）

本节记录候选重建前对页面细节整改源码完成的定向自动化与本地浏览器验证。随后“当前候选
完整链路”另行记录从头执行的整仓发布门禁、production E2E 与 Windows 候选结果。

### 自动化结果

| 范围               |    测试文件 |                  结果 | 状态 | 说明                                                                       |
| ------------------ | ----------: | --------------------: | ---- | -------------------------------------------------------------------------- |
| Desktop 默认全套   |   118 files | 766 passed, 1 skipped | PASS | 跳过项保持显式，不计作通过。                                               |
| Desktop 生产构建   | 912 modules |          build passed | PASS | 类型检查通过；`pdf-import` 分包仍在当前 512,000 bytes 策略上限内。         |
| 共享 UI            |     5 files |             20 passed | PASS | 同批类型检查与 lint 通过。                                                 |
| Web Guest 整改快照 |     4 files |             33 passed | PASS | 覆盖备份导入、高风险提示、自动锁定临时密文恢复、入口与标题层级等整改路径。 |
| Web 生产构建       |  63 modules |          build passed | PASS | 与上述 Web 整改快照对应。                                                  |
| Web 生产 Chromium  |           — |                   2/2 | PASS | 首跑暴露并修正数据库版本漂移后复跑通过。                                   |
| 全仓静态检查       |          20 |         checks passed | PASS | TypeScript、ESLint、Prettier 与 `git diff --check` 均通过。                |

这些分层运行不与 2026-07-30 全仓数字相加；完整候选链的最终证据在下节单独记录。

Web E2E 首跑因测试固定的 IndexedDB 版本未随生产数据库 v2 更新而触发 `VersionError`。
版本检查已改为复用导出的 `WEB_GUEST_DATABASE_VERSION`，修正后生产构建通过
（63 modules），Vitest `4` 个文件、`33` 项通过，Playwright E2E 重新执行 `2/2` 通过。

### 本地浏览器实测

| 场景           | 结果                                                                                                                  | 状态 |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | ---- |
| 设置页独立滚动 | 900×700 视口下，主内容 `clientHeight=624`、`scrollHeight=4110`，`scrollTop` 从 0 变为 900；body 与 shell 高度均为 700 | PASS |
| 设置锚点定位   | 打开 `#data-transfer` 后 `activeId=data-transfer`，目标顶部约等于主内容顶部                                           | PASS |
| 移动侧栏抽屉   | 705 px 下焦点进入、页面背景 inert、`Escape` 关闭并把焦点返回触发按钮                                                  | PASS |
| Web 高风险提示 | 拒绝后保持阻断，复查入口可再次打开说明                                                                                | PASS |
| Web 标题层级   | 页面主标题与后续分区标题顺序通过浏览器复核                                                                            | PASS |

浏览器结果验证的是本地 Chromium 页面行为，不等同于真实 Tauri WebView、Windows 安装包、
长时 IME、磁盘耗尽或内存压力验证。

## 2026-07-31 候选完整链路（历史）

`CI=true pnpm release:candidate:unsigned` 已在 E2E 契约修正后从头执行并通过。完整链路覆盖
格式、秘密、许可证、架构边界、发布配置、20 个 workspace 类型检查、全仓 ESLint、workspace
测试、release 前端与 production Chromium E2E `5/5`，随后生成 Tauri x64 未签名 NSIS。

| 属性               | 结果                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 候选路径           | `archive/2026-07-31-page-remediation-candidate/artifacts/墨影 InkShadow_0.1.0_x64-setup.exe`                                 |
| 生成时间           | `2026-07-31 11:59:40 +10:00`                                                                                                 |
| 大小               | `6,843,820 bytes`                                                                                                            |
| SHA-256            | `0D7E95E468E2A90EE1F7C0DD77058BDC4FC9ABA935DEDC2792B28AB4B00EA189`                                                           |
| 版本与签名         | ProductVersion / FileVersion `0.1.0`；Authenticode `NotSigned`                                                               |
| 源输入指纹         | `9e30417a8477aee5da0d55f82408165abeaec191e54c2e14261b490f4f4bd5ac`；624 文件 / 8,689,055 bytes                               |
| 前端制品指纹       | `b14c634275c2c7b9b96999f959aaa8741e31933c302bee2738af7628380ce805`；67 文件 / 5,172,183 bytes                                |
| 原生程序           | 23,475,200 bytes；SHA-256 `4081A6E067940A018C3173D4D1A2BAF6EAE297E2D23E4B61373DB9222134A8BA`；PE Subsystem `Windows GUI (2)` |
| Rust 补充门禁      | format、严格 clippy 通过；`cargo test` 93 passed、1 ignored、0 failed                                                        |
| 当前候选安装 smoke | `NOT_RUN`                                                                                                                    |

候选文件、原生程序、源码基线和发布 manifest 复制到归档后均重新计算摘要，结果与构建目录一致。
首次 production E2E 因旧断言仍查找整改前的项目卡片 `h3` 而失败；契约更新为当前 `h2`
后先复跑 `5/5`，再从头执行完整候选链并通过。

### 与 2026-07-30 候选的关系

归档的 2026-07-30 未签名 NSIS 是不可改写的历史证据，但它不包含 2026-07-31 页面细节整改。
其安装包哈希、发布清单、production E2E 与全仓门禁不能作为当前源码的新候选证明。页面
整改源码当时由 2026-07-31 候选覆盖；本次发布证据必须等待本页顶部的 2026-08-09 候选链完成。

## 2026-07-30 最终一键链路（历史候选）

`CI=true pnpm release:candidate:unsigned` 已完整通过。

该命令完成发布前格式、秘密、许可证、架构边界、发布配置、TypeScript、ESLint 和 workspace 测试检查，构建 Desktop 生产前端，运行生产 Chromium E2E，并生成未签名 Tauri NSIS。

PowerShell 等价环境设置为：

```powershell
$env:CI = "true"
pnpm release:candidate:unsigned
```

## 2026-07-30 最终自动化结果（历史候选）

| 范围                  |                 测试文件/包 |                  结果 | 状态 | 说明                                                              |
| --------------------- | --------------------------: | --------------------: | ---- | ----------------------------------------------------------------- |
| Desktop 默认全套      |                   117 files | 754 passed, 1 skipped | PASS | 跳过项保留显式外部条件，不伪装为通过。                            |
| Cloud 默认运行        | 21 passed, 16 skipped files | 87 passed, 64 skipped | PASS | PostgreSQL 集成文件在默认无数据库运行中显式跳过。                 |
| Cloud 真实 PostgreSQL |                    37 files |            151 passed | PASS | 角色分离后的全新库全套；最终 FORCE-RLS 加固另有真实库定向 `1/1`。 |
| Workspace packages    |     17 packages / 131 files |            817 passed | PASS | 各包结果可能与定向套件覆盖同一代码，不跨表累加。                  |
| Web Vitest            |                     4 files |             22 passed | PASS | Guest 本地路径。                                                  |
| Web 生产 Chromium     |                           — |                   2/2 | PASS | 使用真实生产静态构建。                                            |
| Desktop 生产 E2E      |                           — |                   5/5 | PASS | 由最终候选链路执行。                                              |
| Rust 默认测试         |                           — |  93 passed, 1 ignored | PASS | 新增已发布迁移校验固定回归；`ignored` 保持显式，不计作通过。      |
| Rust 真实 Ollama      |                           — |                   1/1 | PASS | 单独启用真实 Ollama 的权威门禁。                                  |
| Android JVM           |                           — |                 24/24 | PASS | 不包含 instrumentation 或真机。                                   |
| Enterprise 脚本       |                           — |                   8/8 | PASS | 部署清单、支持与恢复脚本。                                        |
| Updater Rust          |                           — |                   7/7 | PASS | manifest、序列、密钥轮换、反回滚和安全边界。                      |
| Updater UI            |                           — |                   3/3 | PASS | 桌面更新交互。                                                    |
| Node 发布套件         |                           — |                   9/9 | PASS | 发布 manifest、签名与产物检查脚本。                               |
| Marketplace 定向      |                           — |                 10/10 | PASS | 本地安装与客户端治理路径。                                        |
| Backup/restore 定向   |                     2 files |                   7/7 | PASS | 权威数据、派生数据和失败回滚。                                    |

不提供“全项目测试总数”：上表包含默认运行、真实依赖运行及定向套件，存在重复覆盖和不同执行条件，直接相加会生成虚假总和。

## 静态与供应链门禁

| 检查项               | 状态 | 结果                                                 |
| -------------------- | ---- | ---------------------------------------------------- |
| Prettier             | PASS | 全仓格式检查通过。                                   |
| 秘密扫描             | PASS | 仓库扫描通过；不代表附件中曾暴露的外部凭据已经轮换。 |
| 许可证策略           | PASS | 151 个已安装运行时依赖条目符合当前策略。             |
| 架构边界             | PASS | 20 个 workspace 包边界检查通过。                     |
| TypeScript           | PASS | 一键链路中的全部 workspace 类型检查通过。            |
| ESLint               | PASS | 全仓零 warning。                                     |
| Desktop release 配置 | PASS | 生产发布配置和源产物约束通过。                       |

## 重点环境说明

### Cloud

- 默认 Cloud 运行结果为 `21` 个文件通过、`16` 个文件跳过，测试为 `87` 项通过、`64` 项跳过。
- 启用真实 PostgreSQL 后，角色分离版本的全套 `37` 个文件、`151` 项通过；最终 FORCE-RLS
  加固后又以真实数据库定向 `1/1` 验证 `DISABLE RLS` 与缺少 `FORCE ROW LEVEL SECURITY`
  两类漂移及恢复。两次运行属于分层证据，未冒充同一最终源码快照的全套重跑。
- 真实数据库运行覆盖连续迁移、迁移/运行角色分离、TLS 配置、RLS、审计、身份、团队、审阅、用量、删除、Marketplace、维护和同步边界。
- 该证据来自受控本地 PostgreSQL，不代表生产 Kubernetes、外部 TLS、对象存储、邮件、支付、监控或灾备已经验证。

### Desktop、Web 与本地模型

- Desktop 默认全套为 `117` 个文件、`754` 项通过、`1` 项跳过。
- Desktop 的真实 Ollama 权威提取另有显式定向运行；它不并入默认套件总数。
- Web Guest Vitest 为 `4` 个文件、`22` 项，生产 Chromium 为 `2/2`。
- Desktop 候选生产 E2E 为 `5/5`。
- Rust 默认层为 `92` 项通过、`1` 项忽略；显式真实 Ollama 门禁为 `1/1`。
- 真实 Tauri WebView 长时 IME、500 万字符、磁盘耗尽和内存压力仍未执行。

### 移动端与企业脚本

- Android JVM `24/24` 通过，但 Android SDK instrumentation、真机 KeyStore 和设备兼容性矩阵未运行。
- Enterprise 部署、支持和恢复脚本 `8/8` 通过，但未在客户目标基础设施上执行升级、回滚或灾备演练。

### 更新、Marketplace 与备份

- 安全更新器分层结果：Rust `7/7`、UI `3/3`、Node 发布套件 `9/9`。
- Marketplace 定向回归 `10/10`。
- Backup/restore 两个文件、`7/7`。
- 自动化结果不替代正式更新域名、签名证书、硬件/独立密钥托管、强服务端 MFA 或生产备份恢复演练。

## 2026-07-30 候选产物核验（历史）

| 属性               | 结果                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| 路径               | `archive/2026-07-30-delivery-evidence/artifacts/墨影 InkShadow_0.1.0_x64-setup.exe`            |
| 生成时间           | `2026-07-30 00:58:47 +10:00`                                                                   |
| 大小               | `6,837,040 bytes`                                                                              |
| SHA-256            | `1693E7F0598A7262644936A481216A15D7B5BC19BEE03155DB3AD77A0F60EBA8`                             |
| Authenticode       | `NotSigned`                                                                                    |
| 最新候选安装 smoke | `NOT_RUN`                                                                                      |
| 源输入指纹         | `32801fa91e92d2d18a10cbf312489b9c3593b16d6707c8f2255e0b2ba4924d47`；623 文件 / 8,636,950 bytes |
| 前端制品指纹       | `497fdb45352d7488b71cd401eeaf53b86ca320478447a77d25c744937fd4719b`；67 文件 / 5,151,424 bytes  |
| Windows 子系统     | `Windows GUI (2)`；正式构建不创建控制台窗口                                                    |
| `pnpm-lock.yaml`   | SHA-256 `194CAD4508EF773409253536F66B0A196D1466B8D22DBB11FAF785E167F98B26`                     |

该历史候选没有执行安装、首次启动、覆盖升级、卸载或重装。此前更旧候选的安装 smoke
不能迁移为该产物的通过证据；该产物本身也不能迁移为 v0.2.0 当前源码的候选证据。

## 尚未验证或受外部条件阻断

- 附件中曾暴露凭据的外部轮换与审计。
- Authenticode 证书、时间戳、发布主体授权、正式更新域名/通道与独立签名密钥托管。
- 隐私、条款、EULA、AI/训练/Marketplace notices、SLA 和第三方许可的最终法律审批。
- 真实邮件、支付、对象存储、模型、翻译、短剧、训练、SSO 与 IdP 联调。
- 生产 Kubernetes、DNS/TLS、不可变镜像仓库、监控、容量、故障和灾备演练。
- 独立密码学、应用安全、更新链及云数据库角色审计。
- 最新 NSIS 的隔离 Windows 用户安装/升级/卸载矩阵。
- Word/LibreOffice DOCX 逐页视觉 QA、真实 Tauri WebView 压力矩阵和 Android 真机门禁。
- 完整 Web Cloud/项目/团队产品路径。

## 当前结论

v0.2.0 的本次完整自动化、production E2E、NSIS 打包、提交绑定、版本、二进制摘要、远端 CI
和公开附件回读复核均已完成。它已发布为明确标注未签名与边界的 GitHub Pre-release 工程预览；
隔离 Windows 安装矩阵、真实供应商、商业签名、法律审批和独立安全审计未完成，因此不可标记为
Beta、GA 或商业正式版。

## 2026-08-08 P39 自动备份历史增量证据

本节只对应当时的源码增量，不改写其他历史候选统计，也不与历史全仓数字相加。

| 检查                             | 精确命令                                                                                                        | 当前结果                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 自动备份策略、原生端口与生命周期 | `vitest run automatic-backup-service.test.ts automatic-backup-runtime.test.ts runtime-automatic-backup.test.ts` | `3 files / 18 passed`            |
| 相关运行时回归                   | `vitest run runtime-cloud-gates.test.ts runtime-maintenance.test.ts runtime-context.test.tsx`                   | `3 files / 14 passed`            |
| Desktop TypeScript               | `tsc --noEmit -p apps/desktop/tsconfig.json --pretty false`                                                     | PASS                             |
| Desktop production web build     | `pnpm --filter @inkshadow/desktop build`                                                                        | PASS；`2544 modules transformed` |
| P39 定向 ESLint                  | `eslint automatic-backup-service* automatic-backup-runtime* runtime-automatic-backup.test.ts runtime.ts`        | PASS                             |
| Rust 原生全库                    | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib`                                            | `127 passed / 1 ignored`         |
| Rust 编译                        | `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`                                                 | PASS                             |

上述 Rust 用例真实创建临时受管根目录和 SQLite 文件，覆盖稳定所有权标记、并发/过期租约、
manifest compare-and-swap、到期与校验和门禁，以及删除自动备份后手动文件仍存在。TypeScript
覆盖启动立即检查、失败降级不阻断、重检不重叠、关闭清理 timer、浏览器能力为 `null`，以及
受限 ticket 必须调用现有一致性备份服务。尚未把这些自动化结果提升为打包后 Windows 长时间
运行、睡眠唤醒、磁盘满或真实 30 天保留演练的通过证据。
