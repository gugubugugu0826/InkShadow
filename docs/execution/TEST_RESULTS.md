# InkShadow 测试与构建结果

> 文档状态：`HISTORICAL`。本文件冻结 0.2.14 工作树的历史测试快照；0.2.15 当前证据见 `2026-08-29-V0215-RELEASE.md`，不得用本文件替代。

> 更新日期：2026-08-29

> 当前验证对象：`0.2.14` 两轮缺陷统一修复。本轮不修改版本、不构建安装包、不创建或移动标签、不创建或修改 GitHub Release；历史数字不得替代当前工作树结果。

## 2026-08-29 两轮缺陷统一修复当前证据

下表只登记已经在当前候选源码实际运行的结果。测试集合可能重叠，不相加为全仓总数；修复前失败保留为失败证据，跳过项不计为通过。唯一干净提交上的发布态端到端和远端 `main` 核对只能在提交形成后执行，其结果由最终交付报告绑定。

| 范围                     | 准确命令                                                                                                                                                                                                          | 通过 | 失败 | 跳过 | 当前结果与边界                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ---: | ---: | ---------------------------------------------------------------------------------- |
| F5 三文件完整回归        | `pnpm --filter @inkshadow/desktop exec vitest run src/infrastructure/model-hub-execution-service.test.ts src/infrastructure/usage-center-service.test.ts src/pages/usage-center-page.test.tsx --reporter=verbose` |   63 |    0 |    0 | 部分输出、无输出、完整结果、结果待核对和发送阶段中文投影一致。                     |
| F6 本地批量设定          | `pnpm --filter @inkshadow/desktop test -- story-governance-page.test.tsx story-settings-authoring.test.ts`                                                                                                        |   58 |    0 |    0 | 拆分、证据范围、逐条审阅、恢复、项目隔离和零模型调用。                             |
| F7 恢复后续写锚点        | `pnpm --filter @inkshadow/desktop exec vitest run src/pages/editor-candidate-route.test.tsx -t "anchors a professional continuation\|uses an author-selected continuation" --reporter=verbose`                    |    2 |    0 |   72 | 默认正文末尾与作者主动光标两条路径。                                               |
| F10 原生发送边界修复前   | `pnpm --filter @inkshadow/desktop test -- model-hub-embedding-capability-probe.test.ts model-hub-embedding-service.test.ts native-model-gateway-client.test.ts`                                                   |   49 |    4 |    0 | 四个失败分别暴露探针未传同一账本、预检前误记发送、发送后中断未待核对和回执未回传。 |
| F10 原生发送边界修复后   | 同上                                                                                                                                                                                                              |   55 |    0 |    0 | 预检失败零发送；原生回执后失败进入结果待核对；同一调用标识、一次发送、零自动重试。 |
| F10 原生回执聚焦         | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml native_embedding --no-fail-fast`                                                                                                                    |    2 |    0 |    0 | 成功和超时均只写一个不含探针文本与向量的发送回执；209 项被过滤，不计为跳过。       |
| F10 原生身份与作用域聚焦 | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml embedding_invocation_receipt_requires_exact_zero_retry_scope_and_identity --no-fail-fast`                                                           |    1 |    0 |    0 | 零重试、任务、模型、服务商和作用域必须与账本完全一致；210 项被过滤，不计为跳过。   |
| 数据迁移、维护与恢复聚焦 | `pnpm --filter @inkshadow/data test -- author-recovery-sqlite-store.test.ts maintenance.test.ts released-v023-continuous-upgrade.test.ts`                                                                         |   54 |    0 |    0 | `0082` 新库、v0.2.3 连续升级、备份恢复、原始 JSON、修订号和时间戳守恒。            |
| 数据层全量               | `pnpm --filter @inkshadow/data test`                                                                                                                                                                              |  483 |    0 |    0 | 83 个文件；当前数据层全量通过。                                                    |
| AI 核心全量              | `pnpm --filter @inkshadow/ai-core test`                                                                                                                                                                           |  135 |    0 |    0 | 19 个文件；包含长前缀重合检查。                                                    |
| 应用层全量               | `pnpm --filter @inkshadow/application test`                                                                                                                                                                       |   90 |    0 |    0 | 8 个文件；包含接受规划与原子版本合同。                                             |
| 领域层全量               | `pnpm --filter @inkshadow/domain test`                                                                                                                                                                            |   25 |    0 |    0 | 新名称限制与旧长名称安全读取合同。                                                 |
| 发布脚本                 | `pnpm test:scripts`                                                                                                                                                                                               |   40 |    0 |    0 | 当前发布与验证脚本通过，包含构建与发布证明总预算一致性。                           |
| 全仓完整测试             | `pnpm test`                                                                                                                                                                                                       | 4037 |    0 |   65 | 522 个文件通过、16 个文件按约定跳过；桌面端 2634／0／1，数据层 483／0／0。         |
| 类型检查                 | `pnpm typecheck`                                                                                                                                                                                                  |   20 |    0 |    0 | 有类型脚本的 20 个工作区全部通过。                                                 |
| 代码规范                 | `pnpm lint`                                                                                                                                                                                                       | 通过 |    0 |    0 | 退出码 0，无警告或错误。                                                           |
| 格式                     | `pnpm format:check`                                                                                                                                                                                               | 通过 |    0 |    0 | 当前候选全部匹配文件符合格式。                                                     |
| 敏感信息                 | `pnpm check:secrets`                                                                                                                                                                                              | 通过 |    0 |    0 | 没有发现被规则命中的敏感信息。                                                     |
| 许可证                   | `pnpm check:licenses`                                                                                                                                                                                             |  137 |    0 |    0 | 137 个依赖条目通过。                                                               |
| 包边界                   | `pnpm check:boundaries`                                                                                                                                                                                           |   20 |    0 |    0 | 20 个工作区包边界通过。                                                            |
| 桌面发布配置             | `pnpm check:desktop-release`                                                                                                                                                                                      | 通过 |    0 |    0 | 发布配置合同通过；本轮没有构建安装包。                                             |
| 正式构建                 | `pnpm build`                                                                                                                                                                                                      |   20 |    0 |    0 | 有构建脚本的 20 个工作区通过；桌面端处理 2,311 个模块并合并为 25 个块。            |
| 原生层完整门禁           | `pnpm check:rust`                                                                                                                                                                                                 |  210 |    0 |    1 | Rust 格式、`clippy -D warnings` 和库测试通过；1 项真实本地服务测试按约定忽略。     |
| 正式网页端到端           | `pnpm test:e2e`                                                                                                                                                                                                   |   26 |    0 |    0 | 1440、1280、1024、800、浏览器等效 200% 缩放、明暗主题和关键旅程通过。              |
| 提交前发布态端到端       | `pnpm test:e2e:release`                                                                                                                                                                                           |    0 |    1 |    0 | 按设计在来源捕获阶段拒绝脏工作区，未开始旅程；唯一干净提交形成后重跑。             |
| 首次干净提交发布态端到端 | `pnpm test:e2e:release`                                                                                                                                                                                           |    0 |    1 |    0 | 构建通过后，发布证明器仍按旧 7 MiB 拒绝 7,400,736 字节制品；未开始网页旅程。       |
| 发布预算一致性修复前     | `node --test --test-name-pattern="Vite and release attestation" scripts/desktop-release-manifest.test.mjs`                                                                                                        |    0 |    1 |    0 | 稳定证明构建器使用 7 MiB + 128 KiB，而发布证明器仍使用 7 MiB。                     |
| 发布预算一致性修复后     | 同上                                                                                                                                                                                                              |    1 |    0 |    0 | 两个门禁必须使用完全相同的总预算表达式。                                           |
| 变更空白检查             | `git diff --check`                                                                                                                                                                                                | 通过 |    0 |    0 | 当前补丁没有空白错误。                                                             |

正式前端旧总体积上限首次按设计失败：7,400,574 / 7,340,032 字节。隔离发布基线的实体大小为 7,337,824 字节，当前实体大小为 7,400,736 字节，增长 62,912 字节；审计未发现重复运行时、源码映射或测试模块。经用户明确授权，总预算只提高 128 KiB 至 7,471,104 字节，当前计入预算 7,400,574 字节，余量 70,530 字节；入口 300 KiB、异步块 500 KiB、样式 128 KiB、工作线程 1.5 MiB 和一般资源 2 MiB 的单项上限均未改变。

最终执行者只须在唯一干净提交形成后补录 `pnpm test:e2e:release`、提交 SHA、远端 `main` 安全同步与推送后回读一致性。此处不使用占位数字冒充结果。

真实 Qwen、DeepSeek 和其他付费模型、真实安装程序、现场数据库恢复、真实断网及供应商迟到响应、真人鼠标拖选、触摸、视觉检查和操作系统级 200% 缩放均未执行。现场数据库、原始截图与录像、完整诊断包、支持编号、应用和组件调用栈、供应商原始响应均未取得。

## 2026-08-28 第二次远端同源门禁失败与稳定化（历史）

提交 `400120f643f9fccfe929560a39e79f263a384b1d` 已从干净来源完成本地未签名候选并推送到 `main`。GitHub 持续集成运行 `33107276512` 中，`Cloud PostgreSQL and forced RLS` 与 `Windows native shell` 均成功；后者完整通过 Rust 格式、严格静态检查、测试、正式前端演练和未签名 NSIS 打包。`Type, lint, test and web build` 的构建、类型和规范检查成功，但桌面测试有两项失败，因此没有创建标签或 Release。

第一项失败位于开书“说明准备失败”回归的共享连接辅助函数。测试点击“查看固定验证说明”后立即同步寻找确认按钮；产品此时正确处于防重复的“正在处理”状态，异步读取发送路线并计算披露指纹，完成后才会显示可用确认按钮。`user.click` 不会等待组件中被 `void` 启动的异步链，因此慢调度暴露了测试竞态。修复只让测试有界等待“发送固定验证前确认”出现且确认按钮可用，再执行明确确认；产品忙碌、禁用、确认前零发送和防双击逻辑均未修改。同型开书、C3 与快速连接测试一并采用相同等待合同。

第二项失败位于真实文件 SQLite 版本恢复重开测试。旧夹具把 84 份当前迁移、约 672,898 字节 SQL 同步逐条写入 Windows 临时文件；结合该同步实现与修复前后对照，判定 Windows 临时存储上的同步迁移是主要耗时来源。该测试文件总耗时 107,674 毫秒，20 秒测试计时器只能在阻塞调用返回后报告超时。没有断言不匹配、文件权限错误或生产恢复死锁。修复沿用仓库既有模式：完整迁移先在内存执行，再用 `VACUUM INTO` 一次性物化空的真实文件；随后全部创建、编辑、保存、原子版本恢复、关闭、重开、正文、恢复稿和三代不可变版本断言保持原样，20 秒测试上限未放宽。

| 范围                | 准确命令                                                                                                                                                                                                                                                            |  通过 | 失败 | 跳过 | 当前结果                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | ---: | ---: | --------------------------------------------------------- |
| 四组直接回归        | `pnpm --filter @inkshadow/desktop exec vitest run src/pages/idea-journey-page.test.tsx src/pages/idea-journey-c3-regression.test.tsx src/components/quick-ai-connection-drawer.test.tsx src/pages/editor-version-restore-sqlite-reopen.test.tsx --reporter=verbose` |   124 |    0 |    0 | 开书 73、C3 30、连接抽屉 20、真实 SQLite 重开 1，全部通过 |
| SQLite 重开连续验证 | 连续 10 次运行 `pnpm --filter @inkshadow/desktop exec vitest run src/pages/editor-version-restore-sqlite-reopen.test.tsx --reporter=dot`                                                                                                                            |    10 |    0 |    0 | 每轮测试主体约 2.25–2.95 秒；20 秒上限保持原值            |
| 应用层版本恢复      | `pnpm --filter @inkshadow/application test -- tests/chapter-version-restore.test.ts`                                                                                                                                                                                |     7 |    0 |    0 | 原子恢复合同通过                                          |
| 数据仓储与适配器    | `pnpm --filter @inkshadow/data test -- tests/sqlite-repositories.test.ts tests/tauri-sqlite.test.ts`                                                                                                                                                                |    52 |    0 |    0 | SQLite 仓储与 Tauri 适配合同通过                          |
| 桌面端完整测试      | `pnpm --filter @inkshadow/desktop test`                                                                                                                                                                                                                             | 2,554 |    0 |    1 | 296 个文件；约 1,237.64 秒                                |
| 桌面类型检查        | `pnpm --filter @inkshadow/desktop typecheck`                                                                                                                                                                                                                        |     1 |    0 |    0 | 通过                                                      |

上述结果是修复后的本地证据。新的唯一提交仍须重新完成完整未签名候选链，并由该提交触发三项远端作业全部成功；运行 `33107276512` 保留为失败记录，不得用重新运行或旧安装包覆盖。

## 2026-08-28 首轮远端同源门禁失败与稳定化

干净提交 `bd7e3cb96c970eb7c0bba53944401ee8dbcafc04` 的完整本地 `pnpm release:candidate:unsigned` 退出码为 0，随后安全推送到远端 `main`。同一提交的 GitHub 持续集成运行 `33101514463` 中，`Cloud PostgreSQL and forced RLS` 成功，但 `Type, lint, test and web build` 在数据维护套件失败，因此该提交停止在标签和 Release 之前。

准确首因是三条完整付费权威链备份恢复用例仍共用文件型 SQLite 的 15 秒默认测试上限。Windows 执行器上 `running` 场景超过该测试基础设施上限；Vitest 超时不会取消仍在运行的异步操作，随后全局清理尝试删除仍被附加的共享备份文件并得到 `EPERM`，下一条 `settled` 场景又因 `VACUUM INTO` 按安全合同拒绝覆盖现有文件而返回失败。后两个错误均为首次超时的级联，不是新的数据恢复根因。

修复没有修改产品迁移、备份实现或恢复断言：仅三条完整权威链场景沿用仓库已有的 30 秒专项恢复标准，其他文件型 SQLite 测试仍保持 15 秒；每个状态使用独立临时备份路径，并在 `finally` 中先关闭数据库、释放附加库和文件句柄，再删除本用例文件。没有自动重试、忽略 `EPERM` 或删减数据完整性断言。

| 范围               | 准确命令                                                                                                                                                                                                                  | 通过 | 失败 | 跳过／忽略 | 当前结果                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ---: | ---------: | ---------------------------------------------------- |
| 三条权威链聚焦     | `pnpm --filter @inkshadow/data exec vitest run --config vitest.config.ts tests/maintenance.test.ts -t "round-trips a fully reconstructible no-skill paid settled chain\|round-trips a canonical paid" --reporter verbose` |    3 |    0 |         48 | 三种状态均完成真实文件备份、恢复和恢复后权威关系断言 |
| 维护与备份恢复全量 | `pnpm --filter @inkshadow/data exec vitest run --config vitest.config.ts tests/maintenance.test.ts`                                                                                                                       |   51 |    0 |          0 | 完整维护套件通过；约 64.18 秒                        |
| 数据层全量         | `pnpm --filter @inkshadow/data test`                                                                                                                                                                                      |  481 |    0 |          0 | 82 个文件全部通过；约 101.12 秒                      |
| 数据包类型检查     | `pnpm --filter @inkshadow/data typecheck`                                                                                                                                                                                 |    1 |    0 |          0 | 通过                                                 |

上述结果只证明修复后的本地聚焦和数据层门禁。形成新的唯一提交后，仍须重新完成完整未签名候选链，并让新提交的三项远端同源作业全部成功；首轮远端失败不得被重跑结果抹去。

## 2026-08-28 最终发布源重验

最终文案提交 `ba5652e38a49ad691b6cc4e4f32f79ea32628c41` 的首次 `pnpm release:candidate:unsigned` 在故事核心全量阶段失败关闭：四万字正文的三处 UTF-16 证据写入耗时约 2,232.67 毫秒，超过未放宽的 2,000 毫秒门禁。分段计时确认 `0079_story_fact_evidence.sql` 的插入触发器为每一条证据重复逐字符扫描整篇 UTF-8 正文，单次触发约 0.6–0.8 秒；失败发生后未推送、未打标签、未创建 Release，也未使用旧安装包冒充新来源。

修复只新增向前迁移 `0081_story_fact_evidence_guard_performance.sql`／Tauri `84`。项目归属、UTF-16 总长、起止边界、精确摘录和不可变保护保持不变；递归扫描复用前导字节并只走到证据末端，总长改由 SQLite 原生字符与字节运算核对。同一聚焦用例修复前复现为约 2,429.36 毫秒失败，修复后为约 750 毫秒通过；固定上限和断言均未修改。

| 范围               | 准确命令                                                                                                                                                                                                        | 通过 | 失败 | 跳过／忽略 | 当前结果                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ---: | ---------: | ------------------------------------------------- |
| 四万字精确证据聚焦 | `pnpm --filter @inkshadow/story-core exec vitest run tests/story-fact-persistence.test.ts --config vitest.config.ts -t "persists several exact UTF-16 evidence spans" --configLoader runner --reporter verbose` |    1 |    0 |         21 | 约 750 毫秒；2 秒门禁保持原值                     |
| 故事核心全量       | `pnpm --filter @inkshadow/story-core test`                                                                                                                                                                      |  148 |    0 |          0 | 22 个文件全部通过                                 |
| 数据迁移与恢复聚焦 | `pnpm --filter @inkshadow/data exec vitest run --config vitest.config.ts tests/maintenance.test.ts tests/released-v023-continuous-upgrade.test.ts`                                                              |   52 |    0 |          0 | 2 个文件；覆盖当前恢复和 v0.2.3 连续升级到 `0081` |
| 原生迁移聚焦       | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml local_migrations`                                                                                                                                 |   18 |    0 |          0 | Tauri `84` 的新库、旧库、重启和校验历史全部通过   |

上述为修复后的聚焦证据。包含源码、迁移、文档和正式发布说明的最终唯一提交形成后，完整未签名候选链仍须从头运行并退出 0，方可推送和发布。

新增迁移后首次运行生产长篇基准时，迁移尾部断言仍保留旧的 80 文件总数，并且 `0074`–`0077` 的倒数位置没有整体后移，因此在执行 48 个场景前准确失败；实现随后改为核对 81 个文件以及 `0074`–`0081` 的完整连续尾部，聚焦重跑 2／2 通过。该失败未被记为首次通过，仍须由同一最终提交的桌面全量与候选链重新验证。

## 2026-08-27 0.2.14 当前运行记录

下表分组互有重叠，不相加为全仓总数。跳过或忽略项不计为通过。

| 范围               | 准确命令                                                                     |        通过 | 失败 |       跳过／忽略 | 当前结果与边界                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------- | ----------: | ---: | ---------------: | -------------------------------------------------------------------------------------------------------------------------------- |
| 专业创建修复前合同 | `pnpm --filter @inkshadow/desktop test -- professional-create-page.test.tsx` |           7 |    1 |                0 | 失败准确显示旧实现创建了 2 条不应直接晋升的正式记录                                                                              |
| 专业创建修复后合同 | 同上                                                                         |           8 |    0 |                0 | 原始输入、待确认资料、方向、写作偏好和独立约束合同通过                                                                           |
| 界面合同           | `pnpm --filter @inkshadow/ui test`                                           |          42 |    0 |                0 | 6 个文件；恢复被误删的 `.ink-prose` 合同后通过                                                                                   |
| 故事核心全量       | `pnpm --filter @inkshadow/story-core test`                                   |         148 |    0 |                0 | 22 个文件；覆盖事实身份、多证据和作者决定优先                                                                                    |
| 数据层全量         | `pnpm --filter @inkshadow/data test`                                         |         481 |    0 |                0 | 82 个文件；覆盖 `0079`、`0080`、连续升级、旧备份回填和恢复                                                                       |
| 桌面端全量         | `pnpm --filter @inkshadow/desktop test`                                      |       2,554 |    0 |                1 | 296 个文件；跳过项不计为通过                                                                                                     |
| 原子追踪与长篇聚焦 | 桌面运行时追踪提交与生产长篇基准两个聚焦文件                                 |          49 |    0 |                0 | 本地追踪提交失败不伪装成供应商部分结果；基准使用完整 `0001`–`0080` 数据迁移链                                                    |
| 全仓测试           | `pnpm test`                                                                  |       3,945 |    0 |               65 | 514 个文件通过、16 个文件跳过；当前全仓顺序运行                                                                                  |
| 类型检查           | `pnpm typecheck`                                                             | 20 个工作区 |    0 | 1 个无脚本工作区 | 20／21 个提供脚本的工作区通过                                                                                                    |
| 代码规范           | `pnpm lint`                                                                  |        通过 |    0 |                0 | 0 个错误                                                                                                                         |
| 格式               | `pnpm format:check`                                                          |        通过 |    0 |                0 | 当前源码格式通过                                                                                                                 |
| 发布脚本           | `pnpm test:scripts`                                                          |          39 |    0 |                0 | 发布与验证脚本                                                                                                                   |
| 敏感信息           | `pnpm check:secrets`                                                         |        通过 |    0 |                0 | 没有读取凭据值                                                                                                                   |
| 运行时许可         | `pnpm check:licenses`                                                        |         137 |    0 |                0 | 当前锁定依赖                                                                                                                     |
| 包边界             | `pnpm check:boundaries`                                                      |          20 |    0 |                0 | 20 个工作区包通过                                                                                                                |
| 桌面发布配置       | `pnpm check:desktop-release`                                                 |        通过 |    0 |                0 | 版本与发布配置检查通过                                                                                                           |
| 原生层             | `pnpm check:rust`                                                            |         207 |    0 |                1 | Rust 格式与严格静态检查通过；1 项忽略要求显式本地模型环境                                                                        |
| 桌面正式构建       | `pnpm --filter @inkshadow/desktop build`                                     |        通过 |    0 |                0 | 退出码 0；60 个文件、7,337,824／7,340,032 字节，余量 2,208 字节；最大异步分块 494,804／512,000 字节；主 CSS 约 127.36 KB／128 KB |
| 生产浏览器端到端   | `pnpm test:e2e`                                                              |          26 |    0 |                0 | 生产 Chromium 26／26；自动化等效 150%／200% 不是真实 Windows 系统缩放                                                            |
| 完整发布检查       | `pnpm release:check`                                                         |        通过 |    0 |                0 | 首次界面合同失败证据保留；恢复根因后在最终候选链内完整退出 0                                                                     |
| 正式发布端到端     | `pnpm test:e2e:release`                                                      |          26 |    0 |                0 | 干净提交来源基线、正式制品门禁和生产 Chromium 26／26 通过                                                                        |
| 完整未签名候选链   | `pnpm release:candidate:unsigned`                                            |           1 |    0 |                0 | 候选提交 `b4ec54feb51dc651201daa14e635b261bd9f592c` 完整退出 0，生成 x64 未签名 NSIS 并完成打包后来源复核                        |

本轮曾出现并保留以下失败链：数据层全量首次为 476 项通过、5 项失败，原因是两个现代测试夹具遗漏 `0080`；补齐完整迁移链后为 481／481。桌面全量首次为 2,549 项通过、2 项失败、1 项跳过：长篇基准夹具停在旧迁移上限，原子追踪提交错误又被误分到供应商部分结果恢复；修正根因并纳入最终工作树后为 2,554 项通过、1 项跳过。Rust 首次有两项过时迁移上限断言，更新到 Tauri `83` 后为 207 项通过、1 项忽略。首次 `release:check` 在 UI 一项合同失败后停止，准确根因是 `.ink-prose` 界面合同被误删；恢复合同后 UI 6 个文件、42／42、最终全仓 3,945／3,945 和桌面正式构建分别重跑通过，随后又在干净候选链内取得完整退出 0。上述修正没有删除断言、放宽固定包体预算或抹去先前失败记录。

当前桌面正式构建已在固定预算内通过，生产 Chromium 端到端为 26／26；完整未签名候选链已经从唯一干净提交运行并退出 0。正式 README 与发布决定形成新的发布提交后，必须从该提交重新运行完整候选链，旧候选附件不得冒充新提交的同源制品。

三份报告原件和 Q01–Q11、P02–P10、R05–R14 原始材料未取得。真实模型、四项真实技能、真实安装程序、真人视觉、真实触摸和真实 Windows 系统 200% 缩放未执行。自动化等效缩放不能替代系统级与真人验证。

> 以下为 0.2.13 历史候选记录：当时首轮完整未签名候选链因正式前端载荷超出固定上限 670 字节而失败关闭；后续候选证据已冻结。该节不替代上方 0.2.14 当前结果。

## 2026-08-26 0.2.13 当前运行记录

下表分组互有重叠，不相加为全仓总数；跳过或忽略项不计为通过。真实安装报告原文、现场数据库、完整支持编号、诊断包和供应商响应未取得；没有读取凭据原文，没有执行真实模型调用。

| 精确命令或范围                                                                                                                               |               通过 | 失败 | 跳过／忽略 | 证据边界                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -----------------: | ---: | ---------: | ----------------------------------------------------------------------------- |
| `pnpm --filter @inkshadow/desktop test -- src/pages/editor-candidate-route.test.tsx src/pages/editor-version-restore-sqlite-reopen.test.tsx` |                 73 |    0 |          0 | F1 编辑器、真实文件 SQLite 关闭重开、正文／版本／恢复稿守恒                   |
| `pnpm --filter @inkshadow/data test`                                                                                                         |                478 |    0 |          0 | 数据层 81 个文件                                                              |
| `pnpm --filter @inkshadow/story-core test`                                                                                                   |                144 |    0 |          0 | 故事核心 22 个文件                                                            |
| `pnpm --filter @inkshadow/application test`                                                                                                  |                 88 |    0 |          0 | 应用层 8 个文件                                                               |
| 数据迁移、连续升级、维护与备份恢复五文件聚焦                                                                                                 |                 62 |    0 |          0 | 覆盖迁移至 0078、v0.2.3 连续升级、维护和备份恢复；本轮无迁移                  |
| `pnpm --filter @inkshadow/application test -- tests/chapter-version-restore.test.ts`                                                         |                  7 |    0 |          0 | 版本恢复事务                                                                  |
| 故事设定守恒五文件聚焦                                                                                                                       |                 40 |    0 |          0 | 设定、资料、灵感和权威提取持久化                                              |
| 桌面恢复与备份八文件聚焦                                                                                                                     |                 44 |    0 |          0 | F1 重开、自动备份、维护、生命周期与强制结束恢复                               |
| `pnpm --filter @inkshadow/story-core test -- tests/story-fact-persistence.test.ts`                                                           |                 20 |    0 |          0 | F3 精确身份、重启幂等和作者决定保护                                           |
| 桌面设定存储、整理和设定页三个文件                                                                                                           |                 67 |    0 |          0 | F3 并发、历史重复展示与不同类型／内容保护                                     |
| 设置、调查和设定交互三个文件                                                                                                                 |                 99 |    0 |          0 | F2、F4、F5 组件回归                                                           |
| `pnpm --filter @inkshadow/import-export test`                                                                                                |                 96 |    0 |          0 | F6 十一个导入导出文件；修复前 44 通过、5 失败                                 |
| 桌面导出面板与开始页两个文件                                                                                                                 |                 24 |    0 |          0 | F6 空章节和私密项目包前置拒绝；修复前 9 通过、2 失败                          |
| 设置锚点正式 Chromium 旅程                                                                                                                   |                  6 |    0 |          0 | 键盘、深链、刷新、前进后退、1440／1280／1024／800 与等效 200%                 |
| 设定证据正式 Chromium 重复运行                                                                                                               |                  2 |    0 |          0 | 按钮语义、展开状态与焦点；不替代真人视觉和真实触摸                            |
| 正式重排旅程                                                                                                                                 |                  4 |    0 |          0 | 目标宽度、明暗主题和等效 200%；不替代真实系统缩放                             |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`                                                                     |               通过 |    0 |          0 | 原生命令没有测试项计数                                                        |
| `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`                                                |               通过 |    0 |          0 | 严格静态检查，0 警告；命令没有测试项计数                                      |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`                                                                               |                207 |    0 |          1 | 忽略项要求显式 Ollama；没有真实模型调用                                       |
| `pnpm test:scripts`                                                                                                                          |                 39 |    0 |          0 | 发布脚本                                                                      |
| `pnpm check:licenses`                                                                                                                        |                137 |    0 |          0 | 运行时许可                                                                    |
| `pnpm check:boundaries`                                                                                                                      |                 20 |    0 |          0 | 包边界                                                                        |
| `pnpm check:secrets`                                                                                                                         |               通过 |    0 |          0 | 命令没有测试项计数；没有读取凭据值                                            |
| `pnpm check:desktop-release`                                                                                                                 |               通过 |    0 |          0 | 版本与发布配置；命令没有测试项计数                                            |
| `pnpm lint`／`pnpm format:check`                                                                                                             |               通过 |    0 |          0 | 两条命令均通过，没有测试项计数                                                |
| `pnpm --filter @inkshadow/desktop test`（包含于全仓顺序运行）                                                                                |              2,508 |    0 |          1 | 293 个文件全部通过                                                            |
| `pnpm test`                                                                                                                                  |              3,889 |    0 |         65 | 510 个文件通过、16 个文件跳过；跳过项不计为通过                               |
| `pnpm typecheck`／`pnpm build`                                                                                                               |               通过 |    0 |          0 | 均为 20／21 个有脚本的工作区；载荷修复后正式目录为 7,339,928／7,340,032 字节  |
| `pnpm test:e2e`                                                                                                                              |                 25 |    0 |          0 | 首轮 24／25；修正文案后定向 4／4，最终完整复跑 25／25                         |
| `pnpm release:candidate:unsigned` 首轮                                                                                                       | 前置门禁完成后停止 |    1 |          0 | 正式载荷 7,340,702／7,340,032 字节，超出 670 字节；未进入正式候选端到端或打包 |
| `pnpm test:e2e:release`／修复后完整候选链                                                                                                    |     待新的唯一提交 |    — |          — | 必须从头执行，不能沿用首轮残留构建目录                                        |

### 当前失败链与未执行边界

- F1 的较早恢复稿和非当前不可变分支两项修复前稳定失败；当前完整 F1 组合 73／73。非当前不可变分支只允许查看已验证稳定正文，页面只读并阻断全部写入。
- F6 修复前分别出现导入导出 5 项失败、桌面入口 2 项失败；没有删除断言或放宽普通空文件导入，最终分别 96／96、24／24。
- 固定网页包体上限为 7,340,032 字节。首轮完整候选链测得 7,340,702 字节，超出 670 字节并失败关闭；此前单独构建的 7,340,007 字节没有候选准入效力。修复没有提高预算，单独正式构建现为 7,339,928 字节、余量 104 字节；仍须从新的唯一干净提交完整重跑。
- 正式网页端到端首轮 24／25；唯一失败是项目包说明被过度缩短，无法证明“不是本地数据库完整备份”。恢复准确中文合同后，相关单元组合 83／83、定向旅程 4／4、最终完整复跑 25／25。
- 未执行真实 DeepSeek 或其他付费服务、0.2.13 安装程序人工复测、真实 Windows 凭据管理器、原生保存对话框、外部 Word／EPUB／PDF 打开、真实触摸、真人视觉和真实系统百分之二百缩放。

准确缺陷矩阵和数据保护边界见 [`2026-08-26-V0213-BLOCKERS-REMEDIATION.md`](2026-08-26-V0213-BLOCKERS-REMEDIATION.md)。

## 2026-08-25 0.2.12 最终本地门禁（历史发布前快照）

| 精确命令或范围                                                                                                                                           | 当前结果                                                             | 状态与边界                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm test`                                                                                                                                              | 509 个测试文件通过、16 个文件跳过；3,870 项通过、65 项跳过、0 项失败 | 20／21 个工作区进入测试；跳过项不计为通过                                                       |
| `pnpm --filter @inkshadow/desktop test`（包含于全仓顺序运行）                                                                                            | 292 个文件；2,495 项通过、1 项跳过、0 项失败                         | 当前 Desktop 完整测试                                                                           |
| `pnpm typecheck`                                                                                                                                         | 20／21 个工作区通过                                                  | 仅 20 个工作区提供脚本                                                                          |
| `pnpm lint`                                                                                                                                              | 通过                                                                 | 0 个错误、0 个警告                                                                              |
| `pnpm format:check`                                                                                                                                      | 通过                                                                 | 当前源码格式通过                                                                                |
| `pnpm test:scripts`                                                                                                                                      | 39 项通过                                                            | 0 项失败、0 项跳过                                                                              |
| `pnpm check:secrets`                                                                                                                                     | 通过                                                                 | 没有读取真实凭据                                                                                |
| `pnpm check:licenses`                                                                                                                                    | 137 项运行时许可通过                                                 | 当前锁定依赖                                                                                    |
| `pnpm check:boundaries`                                                                                                                                  | 20 个包通过                                                          | 当前架构边界                                                                                    |
| `pnpm check:desktop-release`                                                                                                                             | 通过                                                                 | 当前发布配置                                                                                    |
| `pnpm build`                                                                                                                                             | 20／21 个含构建脚本的工作区通过                                      | Desktop 2,306 个模块、27 个分块；总量 7,335,567／7,340,032 字节；最大分块 489,186／512,000 字节 |
| `pnpm check:rust`                                                                                                                                        | 207 项通过、0 项失败、1 项忽略                                       | `cargo fmt`、严格 `clippy -D warnings` 和完整库测试通过                                         |
| `pnpm test:e2e`                                                                                                                                          | 21／21 通过                                                          | 正式构建网页旅程；0 项失败、0 项跳过                                                            |
| `node scripts/check-visual-evidence.mjs`                                                                                                                 | 40 条记录、40 个唯一 PNG 通过                                        | 与端到端退出 0 共同证明浅色、深色、目标宽度和等效 200% 矩阵；不等于真人视觉复核                 |
| `node scripts/run-e2e.mjs tests/e2e/desktop-local-first.spec.ts --grep "imports into the first chapter and exports validated artifacts and diagnostics"` | 1／1 通过                                                            | 浏览器下载与重新解析；不替代原生保存对话框                                                      |
| `pnpm --filter @inkshadow/data test`                                                                                                                     | 81 个文件、478 项通过                                                | 0 项失败、0 项跳过                                                                              |
| 连续升级聚焦                                                                                                                                             | 2 个文件、2 项通过                                                   | 覆盖 Data `0078`，现场旧库未取得                                                                |
| 原生迁移聚焦                                                                                                                                             | 18 项通过                                                            | 覆盖 Tauri `81`，不替代真机覆盖升级                                                             |
| 备份恢复                                                                                                                                                 | Desktop 31 项、原生层 19 项通过                                      | 自动化合同，不替代安装程序真机恢复                                                              |
| 导入导出                                                                                                                                                 | 导入导出 91 项、Desktop 导出 24 项、原生导出 9 项通过                | 原生保存对话框与外部应用打开未执行                                                              |
| 私密章节发送门禁                                                                                                                                         | 12 项通过、148 项因名称筛选未运行                                    | 受测路径零发送；没有真实付费调用                                                                |
| 创作状态链                                                                                                                                               | 160 项通过                                                           | 可控本地环境，不冒充真实供应商验证                                                              |

### 当前失败记录与闭环

1. 首次全仓测试的 Desktop 为 290 个文件通过、2 个文件失败；2,485 项通过、2 项失败、1 项跳过。失败分别是普通界面合同仍查找固定 JSX“缩写”文本，以及关闭与取消合并用例在全量负载下于 5.023 秒超时。修复只更新数据驱动合同断言并拆分两个独立零发送场景，没有修改生产门禁或放宽全局超时；聚焦 71／71、两条独立场景各 1／1，最终全仓通过。
2. 正式构建首次为 7,344,006／7,340,032 字节，超出固定预算 3,974 字节。没有提高预算；关闭不必要的模块预加载并压缩等价 SQL 字面量后，相关存储与生成回归 30／30、98／98 通过；两条提交前阻断修复纳入后，最终构建为 7,335,567 字节，余量 4,465 字节。
3. 首次 `pnpm check:rust` 的格式和严格静态检查通过，测试为 206 项通过、1 项失败、1 项忽略。唯一失败是新增 Tauri 迁移 81 后，迁移诊断测试仍期待旧上限 80；测试期望同步为 81 后，聚焦及完整复跑通过，最终 207／0／1。
4. 正式网页端到端首轮为 19／21。两项失败来自旧重复入口定位，没有触发产品断言；两条定位修正后分别 1／1，通过后完整复跑 21／21。
5. 应用内浏览器复核两次均在打开页面前被 Windows 沙箱辅助进程 `helper_unknown_error` 阻断，未取得页面、截图或人工交互证据。这是未执行边界，不计为应用失败或通过。

专项矩阵、数据守恒和未执行边界见 [`2026-08-25-V0212-RETEST-RELEASE.md`](2026-08-25-V0212-RETEST-RELEASE.md)。本节是当时最终本地门禁源码快照；其中候选链和发布“待执行”只描述该历史时点。v0.2.12 后续已经发布并固定解析到 `8d20dfbbdac1eaecdde046714ba257257cd68ace`，其标签、Release 和附件保持不可变；上述源码门禁不能替代当前 0.2.14 结果。

## 2026-08-25 0.2.11 当前运行记录

当前工作树已经取得下列当前运行证据。跳过项保持显式，不计为通过；各组结果不得相加为新的全仓总数。

| 验证范围                 | 通过 | 失败 | 跳过 | 证据边界                     |
| ------------------------ | ---: | ---: | ---: | ---------------------------- |
| 发布证据脚本             |   39 |    0 |    0 | 当前脚本组                   |
| 原生层                   |  207 |    0 |    1 | 当前完整原生测试             |
| 私密章节、导出与备份恢复 |   60 |    0 |    0 | 自动化验证                   |
| 导入导出                 |   91 |    0 |    0 | 自动化落盘合同               |
| 导入整理                 |    4 |    0 |    0 | 本机整理链                   |
| 项目导入                 |    3 |    0 |    0 | 项目导入链                   |
| 开书状态链               |  177 |    0 |    0 | 可控测试，不是真实供应商调用 |
| 非桌面端 19 个工作区合计 | 1374 |    0 |   64 | 当前工作区测试               |
| 普通用户界面用语检查     |  105 |    0 |    0 | 中文投影                     |
| 任务目录相关检查         |   10 |    0 |    0 | 异常元数据与未知地区安全回退 |
| 许可检查                 |  137 |    0 |    0 | 通过                         |
| 边界检查                 |   20 |    0 |    0 | 通过                         |
| 敏感信息扫描             |    — |    0 |    — | 通过                         |
| 发布配置检查             |    — |    0 |    — | 通过                         |
| 桌面端完整测试           | 2462 |    0 |    1 | 289 个测试文件               |
| 全仓类型检查             |   20 |    0 |    0 | 20 个工作区通过              |
| 全仓代码规范检查         |    1 |    0 |    0 | 通过                         |
| 全仓格式检查             |    1 |    0 |    0 | 通过                         |
| 根级正式构建             |   20 |    0 |    0 | 20／21 个工作区有构建脚本    |
| 提交前生产网页端到端首轮 |   13 |    6 |    0 | 修复前失败证据               |
| 提交前生产网页端到端复跑 |   19 |    0 |    0 | 当前生产构建网页旅程         |
| 桌面正式网页构建         |    1 |    0 |    0 | 包体预算通过，余量 452 字节  |

`pnpm test:e2e` 首轮为 13／19，通过修复后复跑为 19／19；`pnpm test:e2e:release` 在候选来源捕获阶段按设计拒绝脏工作区，未开始正式候选旅程，必须在唯一干净提交形成后重跑。`pnpm --filter @inkshadow/desktop build:web` 的最终网页包为 7,339,580／7,340,032 字节，距离固定上限仅余 452 字节。桌面端完整测试、全仓类型检查、全仓代码规范检查、全仓格式检查和根级正式构建均已通过；干净提交上的完整候选链仍待执行。应用内浏览器交互复核在启动浏览器客户端前因 Windows 沙箱辅助进程 `helper_unknown_error` 失败，未取得页面证据。真实供应商验证未执行；现场数据库和完整现场诊断材料未取得；真人视觉复核未执行。现有私密章节、导出与备份恢复数字不替代安装程序人工落盘、外部打开和真机恢复。

候选提交、来源指纹、安装包、签名状态和回下载结果尚未取得。真实供应商调用、真实旧库覆盖安装、Windows 凭据管理器重建数据库场景、真实系统百分之二百缩放和真人视觉复核均未执行；现场数据库和完整现场诊断材料未取得，不得写成通过。本轮没有新增数据库迁移，也没有创建标签或 GitHub Release。D1 自动化确认旧实现对 LF／CRLF 换行字节使用唯一 SHA-384 回执会误拒绝合法历史；D2 原生到网页的可信来源正向链已由自动化证明，但真实 Windows 凭据管理器仍未执行。准确命令、分项数字和缺陷绑定见 [`2026-08-24-V0211-BLOCKERS-UI-REMEDIATION.md`](2026-08-24-V0211-BLOCKERS-UI-REMEDIATION.md)。

## 2026-08-24 0.2.10 当前运行记录（历史候选）

当前工作树已取得：开书与 C3 两文件 100／100、P0-1 五文件 119／119、数据层 80 文件 477／477、桌面端 284 文件 2,410 项通过／1 项按约定跳过、原生库 195 项通过／1 项显式忽略，以及类型、规范、格式、正式构建、敏感信息、许可证、包边界、桌面发布配置和 39 项脚本测试通过。正式网页端到端与完整未签名候选链会拒绝脏工作树，必须在唯一候选提交形成后重跑；候选安装包和人工验证尚未取得，不填写未知提交或制品摘要。

完整矩阵见 [`2026-08-24-V0210-ROUND2-REMEDIATION.md`](2026-08-24-V0210-ROUND2-REMEDIATION.md)。

## 2026-08-24 v0.2.9 报告缺陷与自动化结果（历史候选形成阶段）

C1、C2 的根因来自当时现场页面证据与源码的联合核对：均可在对应源码稳定复现并与现场现象一致，但缺少的现场日志、能力和路由快照意味着它们不能被写成现场唯一根因。表中标为“独立安全审计”的两项不是报告新增缺陷。`v0.2.9` 后续已从提交 `54d9647031bb97b4fc9f021d3b1acca7f6d25c47` 发布；下表原有数字保持为该候选阶段证据，不得视为 0.2.10 当前结果。

| 范围                           | 精确命令                                                                                                                                                                     | 当前结果     | 证明范围                                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 写作方式                    | `pnpm --filter @inkshadow/desktop test -- src/pages/settings-page.test.tsx`                                                                                                  | 聚焦回归通过 | 结合现场页面证据与当前源码可稳定复现且与现场现象一致：已保存专业偏好呈现为两个可操作按钮，不出现虚假加载，切换前后均没有模型调用；报告脚本只查按钮的旧证据不能单独证明 v0.2.8 一直加载。 |
| C2 结构化能力路由              | `pnpm --filter @inkshadow/desktop test -- src/infrastructure/model-hub-router.test.ts src/infrastructure/model-hub-routing-service.test.ts src/pages/settings-page.test.tsx` | 聚焦回归通过 | 结合现场页面证据与当前源码可稳定复现且与现场现象一致：普通文字能力不再自动取得规划分工；经验证的结构化输出可路由，旧版自动计划安全重算并保留手工路由；不冒充现场唯一根因。               |
| C3 同步重入围栏                | `pnpm --filter @inkshadow/desktop test -- src/pages/editor-generation-reentry.test.tsx`                                                                                      | 聚焦回归通过 | 三百毫秒双击只有一个发送披露、一次准备和确认前零发送；重复确认只派发一次。                                                                                                               |
| 独立安全审计：确认复核取消竞态 | `apps/desktop/src/pages/editor-generation-reentry.test.tsx`                                                                                                                  | 3／3 通过    | 关闭先于确认复核完成时保持零派发；旧操作不能在 `finally` 中清除新操作的忙碌状态；保存待执行期间关闭不会误记取消。                                                                        |
| B3 生产接受与零条文案          | `pnpm --filter @inkshadow/desktop test -- src/infrastructure/direct-story-fact-organizer.test.ts src/pages/editor-candidate-route.test.tsx`                                  | 聚焦回归通过 | 接受明确证据后在本机形成带版本和原文范围的待确认设定，零模型调用；零条结果显示诚实说明和一句话设定入口。                                                                                 |
| 九万六千零八十八字内存正确性   | `pnpm --filter @inkshadow/desktop test -- src/pages/editor-candidate-route.test.tsx`                                                                                         | 聚焦回归通过 | 只证明内存开发运行时中的完整展示、接受、新版本和旧版本不变；没有测量真实 SQLite、Tauri 或安装程序耗时。                                                                                  |
| 独立安全审计：失败后单次派发   | `pnpm --filter @inkshadow/desktop test -- src/infrastructure/generation-runtime.test.ts src/infrastructure/model-hub-execution-service.test.ts`                              | 聚焦回归通过 | 可重试上游失败仍只派发一次并终结旧任务；旧计划不能重发，空白可见输出不会记为成功。                                                                                                       |
| 独立安全审计：开头失败关闭     | `pnpm --filter @inkshadow/desktop test -- src/infrastructure/model-hub-creative-chain-integration.test.ts`                                                                   | 聚焦回归通过 | 准备、隐私、路由、空输出、短截断和发送失败不再自动替换为本地故事；没有伪正文、候选或自动重试。                                                                                           |
| 历史待决定结果                 | 未新增自动化命令                                                                                                                                                             | 剩余风险     | 报告要求补充过期标记、查看、放弃和保留策略；当前不得自动删除历史结果，也不得把发布后资源清理当作候选清理。                                                                               |

### 当前运行时序与精确结果

| 阶段               | 实际命令或运行范围                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 结果                                                           | 说明                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 数据层全量         | `pnpm.cmd --filter @inkshadow/data test`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 80 个文件、477 项通过、0 项失败、0 项跳过                      | 当前运行通过。                                                                          |
| 桌面端第一次全量   | `pnpm.cmd --filter @inkshadow/desktop test`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 280 个文件通过、2 个文件失败；2,369 项通过、4 项失败、1 项跳过 | 两条开书共同错误码被聚合降级；两条路由可见性夹具缺结构化输出证据。保留为失败证据。      |
| 原失败聚焦复跑     | 原失败 4 条                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 4／4 通过                                                      | 修复错误码传播和测试夹具后复跑。                                                        |
| 相关完整文件复跑   | 3 个相关完整测试文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 134／134 通过                                                  | 不与全量数字相加。                                                                      |
| 修复中组合回归     | `pnpm.cmd --filter @inkshadow/desktop exec vitest run --config vitest.config.ts --configLoader runner src/infrastructure/diagnostics.test.ts src/infrastructure/direct-story-fact-organizer.test.ts src/infrastructure/generation-runtime.test.ts src/infrastructure/model-hub-creative-chain-integration.test.ts src/infrastructure/model-hub-execution-service.test.ts src/infrastructure/model-hub-router.test.ts src/infrastructure/model-hub-routing-service.test.ts src/infrastructure/model-hub-store.test.ts src/infrastructure/model-hub-story-planning-service.test.ts src/pages/editor-candidate-route.test.tsx src/pages/editor-generation-reentry.test.tsx src/pages/settings-page.test.tsx` | 12 个文件、332 项通过、0 项失败、0 项跳过                      | 发生在后续新增两条竞态测试和共同错误码修复之前，仅作为修复中聚焦证据。                  |
| 桌面端第二次全量   | `pnpm.cmd --filter @inkshadow/desktop test`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 282 个文件通过；2,373 项通过、0 项失败、1 项跳过               | 当前运行通过；跳过项不计为通过。                                                        |
| 生成重入复跑       | `pnpm.cmd --filter @inkshadow/desktop test -- src/pages/editor-generation-reentry.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 3／3 通过                                                      | 三条竞态独立结算。                                                                      |
| 类型检查           | `pnpm.cmd typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 通过                                                           | 当前工作树。                                                                            |
| 代码规范           | `pnpm.cmd lint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 通过                                                           | 当前工作树。                                                                            |
| 格式检查           | `pnpm.cmd format:check`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 通过                                                           | 当前工作树。                                                                            |
| 桌面版本来源       | `pnpm.cmd check:desktop-release`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 通过                                                           | 权威桌面清单一致。                                                                      |
| 差异空白检查       | `git diff --check`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 通过                                                           | 当前差异无空白错误。                                                                    |
| 网页端旅程         | `pnpm.cmd --filter @inkshadow/web test:e2e`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 2 项通过                                                       | 开发服务器运行，不是正式 `dist` 或 Tauri。                                              |
| 正式构建           | `pnpm.cmd build`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 退出码 0；21 个工作区正式构建通过                              | 已生成 Tauri 所需的正式前端 `dist`；不等于正式发布版网页端到端或安装程序验证。          |
| 原生层首次顺序证据 | 正式前端 `dist` 尚不存在时单独执行 `pnpm.cmd check:rust`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 因 Tauri `frontendDist` 前置条件停止                           | 不是 Rust 源码诊断通过或失败；保留首次执行顺序证据。                                    |
| 原生层最终门禁     | 正式构建后执行 `pnpm.cmd check:rust`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 退出码 0；194 项通过、0 项失败、1 项忽略；测试阶段 162.92 秒   | `cargo fmt`、`clippy -D warnings` 通过；库测试完整 195 项，主程序 0 项、文档测试 0 项。 |

正式构建和原生层最终门禁已经通过；当前还没有完成完整干净提交候选链、正式发布版网页端到端、未签名打包、远端持续集成或发布。上述聚焦、首次失败、复跑和第二次全量数字各自绑定对应运行，不重复相加。

本节不记录未知通过数、提交 SHA、附件或性能数字。现场 SQLite 与自动备份已随附件提供，但按本轮安全边界未读取；真正未取得的是测试现场当时的安装包来源提交、未落盘的脱敏诊断包、C1/C3 支持编号、可绑定 C1–C3 的应用日志与调用栈、C2 能力和路由快照，以及可审计的长文接受性能轨迹。附件中的两个运行日志为空；验收画布状态为 `compile-error`，不构成通过。仓库保留清单后来绑定的 `5cf76d410652c40eec13fd1a372fd6cacec8b2a6` 是仓库侧后验来源清单，不是现场当时取得的提交。

报告跳过了代表试改，以及扩写、润色、缩写独立入口。报告未执行断网／超时注入、百分之二百缩放、图片生成和 1280 目标宽度；`Ctrl+K`／`Esc` 仅继承 v0.2.7 同组件历史证据，坏附属记录未在现场库注入。当前也没有执行付费服务、真实凭据、真实安装、真实安装性能、人工恢复、完整候选门禁或发布动作。

## 2026-08-24 v0.2.8 版本与人工复测安装包证据

| 范围           | 精确命令                                                                          | 结果                                                            |
| -------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 依赖恢复       | `pnpm install --frozen-lockfile`                                                  | 通过；锁文件不变，589 个依赖从本机缓存恢复                      |
| 版本与正式配置 | `pnpm check:desktop-release`；Cargo 元数据检查                                    | 通过；权威版本一致，Cargo 应用包为 0.2.8                        |
| 诊断版本       | `pnpm --filter @inkshadow/desktop test -- src/infrastructure/diagnostics.test.ts` | 首次因清理后的共享包编译输出未重建而 0 项收集；重建后 5／5 通过 |
| 桌面端类型     | `pnpm --filter @inkshadow/desktop typecheck`                                      | 同一环境前置问题修复后通过                                      |
| 未签名打包     | `pnpm --filter @inkshadow/desktop tauri:build:unsigned`                           | 通过；正式网页 2,300 个模块，生成 0.2.8 NSIS 安装器             |
| 来源复核       | `pnpm release:verify:unsigned`                                                    | 通过；正式配置、来源提交、网页文件清单和哈希一致                |

本轮只修改版本来源，为尽快先提供人工复测包，没有重复完整源码、原生层和 17 项正式网页旅程，也没有运行完整未签名候选链。安装包尚未启动；不把构建成功写成真实安装通过。

## 2026-08-23 v0.2.7 两轮复测修复聚焦证据（未发布工作树）

状态：`当前源码、原生层与正式网页端自动化门禁通过 / 未发布 / 不建议发布`。

本节只绑定分支 `codex/v0.2.7-round2-fixes` 的当前工作树，不属于冻结的 `v0.2.7` 候选或公开附件。各命令单独运行，数字不得相加成全量结果。

| 范围                      | 精确命令                                                                                                                                                                                                                                    | 当前结果                             | 证明范围                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C2 数据读取隔离           | `pnpm --filter @inkshadow/data test -- sqlite-repositories.test.ts`                                                                                                                                                                         | 29 项通过、0 项失败、0 项跳过        | 单条候选校验值损坏时保留坏行、隔离诊断且返回其他安全候选；四万零九百三十六字正文与不可变版本摘要在重开前后不变。                                         |
| C2 编辑器                 | `pnpm --filter @inkshadow/desktop test -- src/pages/editor-candidate-route.test.tsx`                                                                                                                                                        | 52 项通过、0 项失败、0 项跳过        | 可选候选损坏时正文继续打开、显示稳定支持编号并可重新读取；不可变版本不安全时停止写入，重启保留同一事故，恢复后重新读取且权威内容不变。                   |
| C2 诊断与错误边界         | `pnpm --filter @inkshadow/desktop test -- src/infrastructure/ui-route-diagnostics.test.ts src/components/app-error-boundary.test.tsx`                                                                                                       | 7 项通过、0 项失败、0 项跳过         | 持久支持编号、白名单项目/章节/候选标识、读取阶段、原因链、脱敏应用栈和组件栈；正文、凭据、绝对路径、任意查询内容和原始异常消息不落入诊断。               |
| B6 规划披露               | `pnpm --filter @inkshadow/desktop test -- src/components/story-planning-panel.test.tsx`                                                                                                                                                     | 8 项通过、0 项失败、0 项跳过         | 空规划与已有规划均能查看正常发送信息；准备失败显示准确阶段、零次调用、恢复动作和支持编号，不显示内部错误码。                                             |
| P2 当前会话精确确认       | `pnpm --filter @inkshadow/desktop test -- src/infrastructure/continuation-confirmation-session.test.ts src/pages/editor-candidate-route.test.tsx -t "continuation confirmation \| reuses only an explicit exact continuation confirmation"` | 12 项通过、0 项失败、51 项因过滤跳过 | 只复用作者显式授予且作品、章节、正文版本、模型、服务、任务、资料范围、隐私去向和披露指纹完全相同的当前会话确认；命中后仍显示摘要并要求点击，不静默发送。 |
| P2 中文术语与 P3 缩写隔离 | `pnpm --filter @inkshadow/desktop test -- src/infrastructure/editor-generation-completion-policy.test.ts src/ordinary-ui-language-contract.test.ts`                                                                                         | 12 项通过、0 项失败、0 项跳过        | 普通界面使用“本次挑选的故事资料”“服务商未提供费用信息”；“缩写”入口使用真实选区动作，完成结果仍保持隔离。                                                 |
| 诊断包 schema 4           | `pnpm --filter @inkshadow/desktop test -- src/infrastructure/diagnostics.test.ts`                                                                                                                                                           | 5 项通过、0 项失败、0 项跳过         | 诊断包导出安全操作支持编号、阶段、发送状态和零自动重试事实，并排除正文、提示词、凭据、完整消息和不安全请求标识。                                         |

### C2 根因与现场证据边界

当前源码与构造坏行稳定证明：候选仓库原先对整组可选候选执行严格反序列化；一条坏候选会使整组读取失败。编辑器又把候选读取与项目、章节和不可变版本放进同一个并行聚合，导致可选坏行把正文页面一并推入错误状态；旧重试没有改变读取策略，所以会重复失败。修复后只隔离可选坏候选，原行不删除、不改写；权威项目、章节或不可变版本不安全时仍失败关闭。

“橘猫第一章”“深夜电台”的现场数据库、原始诊断文件、准确触发行和旧版应用/组件调用栈均**未取得**。现有材料不能证明这两个项目一定由候选校验值损坏触发，也不能排除旧版本、共享任务元数据或其他坏行；不得把构造用例写成现场复现。

### 本轮尚未执行

- C3 开书旅程 3 个聚焦文件 48／48、完整页面 68／68；B3 整理器 19／19、SQLite 持久化 19／19、浏览器事实仓库 15／15。
- `pnpm release:check`：489 个测试文件、3678 项通过、65 项跳过、0 项失败；构建、格式、凭据扫描、137 项许可、20 个包边界、17 项发布配置、全工作区类型和规范均通过。`pnpm check:rust`：194 项通过、1 项真实本地模型联调忽略、0 项失败。正式网页候选从干净提交生成，来源与产物清单核对通过；首次端到端因缺少测试浏览器未启动，安装匹配运行时后 17／17 通过。
- 真实安装程序、真实服务商、真实凭据、付费调用、真实慢连接、真机恢复和人工界面矩阵均未执行。
- 当前工作树尚未形成干净唯一提交，也未推送、打标签或发布。目标现场数据库、真实安装程序、真实服务和人工矩阵仍未取得或未执行，因此当前不建议发布；任何后续修复版必须使用新版本号。

## 2026-08-23 v0.2.7 最终候选、远端门禁与公开预发行

状态：`候选通过 / 远端通过 / 已发布未签名工程预览 / 外部与人工验证仍未执行`。

### 最终干净候选与分项结果

最终候选与标签解析提交均为 `cb97876894d6f02c4c901745c95533da7b0260fe`；候选执行前后工作区均干净。发布后的文档提交可以推进 `main`，但 `v0.2.7` 标签、发布清单与三个附件必须继续固定在该候选。

| 范围             | 精确命令或来源                    | 最终结果                                                                                                                                                                     |
| ---------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完整未签名候选链 | `pnpm release:candidate:unsigned` | 退出码 0；来源、测试、构建、端到端和打包完整通过                                                                                                                             |
| 未签名制品复核   | `pnpm release:verify:unsigned`    | 退出码 0                                                                                                                                                                     |
| 全工作区测试     | 候选链中的 `pnpm test`            | 480 个文件通过、16 个文件跳过；3,558 项通过、65 项跳过                                                                                                                       |
| 桌面端           | 同一次全工作区运行                | 271／271 个文件；2,216 项通过、1 项跳过、0 项失败；935.18 秒                                                                                                                 |
| 数据层           | 同一次全工作区运行                | 73／73 个文件；453／453 通过                                                                                                                                                 |
| 网页端           | 同一次全工作区运行                | 4／4 个文件；33／33 通过                                                                                                                                                     |
| 原生层           | 格式、严格静态检查与测试          | 194 项通过、1 项忽略、0 项失败；191.15 秒                                                                                                                                    |
| 正式浏览器旅程   | 候选正式网页构建                  | 17／17 通过，约 1.7 分钟；40 张唯一视觉证据图                                                                                                                                |
| 来源指纹         | 发布清单                          | 1,257 个文件、21,687,616 字节；SHA-256 `5d9bb2ba0ea0e5e715708d4bb9715f9846547d79de20c2fe16577d0db8ee5e95`                                                                    |
| 正式网页制品     | 发布清单                          | 59 个文件、7,170,926 字节；SHA-256 `10eb6efcaed652f40f18fe586ad4faacc2c56e6a9427847b66b585c1883ec4c3`                                                                        |
| 环境指纹         | 发布清单                          | 0 个变量；SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`                                                                                         |
| Windows 安装程序 | 候选输出与公开回下载              | `InkShadow_0.2.7_x64-setup.exe`；7,709,375 字节；SHA-256 `6026918e47100360fad564cd17a15070d448ab6b460dfbf5f72467e71a23622b`；产品/文件版本 `0.2.7`；`Authenticode=NotSigned` |
| 发布清单         | 候选输出与公开回下载              | 11,710 字节；SHA-256 `f1b94f50fb98b24ae634a3d5307c729693d70134946384de923806e511b77685`；`gitCommitSha` 匹配候选                                                             |
| 两行校验文件     | 候选输出与公开回下载              | `SHA256SUMS` 194 字节；SHA-256 `fa811ff9962a92e4b247d17407dd2be97c4c4b722888ec4d76a3c3e0c2598b87`；两行均验证                                                                |

全工作区数字来自最终候选的一次完整运行，不与聚焦复跑重复相加。跳过和忽略项保持显式，不计为通过。

### 首次失败、修正与最终复跑

- 第一次运行 `pnpm release:check` 时仅有 5 个测试文件中的 8 项失败，全部属于夹具或断言与当前产品事实发生漂移；失败记录保留，不把首次失败算作通过。
- 修正测试夹具和断言后，原 5 个文件定向复跑 39／39 通过。
- 最终重新运行 `pnpm release:check`，退出码为 0；全工作区测试、格式、类型、代码规范、正式构建和相关静态门禁均通过。
- 原生层曾在正式构建前单独尝试：清理后的 `apps/desktop/dist` 不存在，原生上下文生成因缺少前端制品停止。该次只作为历史首次尝试，既不记为源码失败，也不记为通过。完成正式构建后，`pnpm check:rust` 最终复跑通过：194 项通过、1 项因显式本地模型条件忽略、0 项失败。

### 已记录的最终命令

- `pnpm release:check`：最终退出码 0。
- `pnpm test`：480 个文件通过、16 个文件跳过；3,558 项通过、65 项跳过。
- 桌面端测试：271 个文件；2,216 项通过、1 项跳过、0 项失败。
- 数据层测试：73 个文件；453／453 通过。
- 网页端测试：4 个文件；33／33 通过。
- `pnpm build`：通过；网页端转换 1,616 个模块、桌面端转换 2,289 个模块，构建预算通过。
- `pnpm check:rust`：194 项通过、1 项因显式本地模型条件忽略、0 项失败。
- `pnpm format:check`、`pnpm typecheck`、`pnpm lint` 与 `git diff --check`：全部通过。

### 初始干净提交候选链

初始候选来源提交为 `95904b39a0c2e6c21c30beb0bf02c891dbd798d4`。第一次执行 `CI=true pnpm release:candidate:unsigned` 时，完整源码门禁和原生层均通过，但发布端到端在启动 Chromium 前发现对应版本浏览器未安装；17 项都没有运行产品断言，因此不记为 0／17 产品失败，也不记为通过。

安装与 Playwright 匹配的 Chromium 后，从同一干净提交再次完整执行候选链。源码门禁、正式构建、原生层 194 项通过／1 项按外部条件忽略、来源基线与发布清单生成均通过；浏览器端到端为 10／17，通过 10 项、失败 7 项，打包阶段未执行。失败证据保留如下：

- 导入导出长链仍定位旧英文备份按钮和旧英文诊断文件前缀；产品已经显示中文名称。
- 三项模型中心响应式用例在模型夹具写入既有连接并重载后，仍要求全新安装直接模式；修正为先在真正空状态显式切专业模式，再写入夹具，保留既有数据升级到专业模式的保护。
- 视觉证据用例发现直接想法页缺少可访问的主要区域语义；四个互斥页面根节点补齐同一主要区域角色。
- 1024 设置页选择框与 800 想法页按钮实测高度为 40 像素；产品样式提高到设计令牌规定的 44 像素，测试标准未降低。

修正后的发布网页构建执行 `CI=true node scripts/run-e2e.mjs --dist apps/desktop/dist-release`，17／17 通过，用时 1.6 分钟；其中本地导入导出完整单文件 4／4、响应式两项 2／2、模型中心与视觉证据 4／4 均通过，并生成 40 张唯一图片。该工作树结果没有被冒充为最终候选，随后同一矩阵在最终干净提交再次 17／17 通过，约 1.7 分钟。

### 修正后干净提交的候选首跑

`ddd121b517ac32a0aacc5f63a3f1ebca3b457b64` 从清洁工作树启动完整候选。正式构建、格式、秘密扫描、137 个运行时许可证、20 个包边界、17 项发布配置、全工作区类型与代码规范均通过；数据层 73 个文件／453 项通过。桌面端完整结果为 270 个文件通过、1 个文件失败；2,215 项通过、1 项失败、1 项跳过，用时 932.91 秒。候选因此在工作区测试阶段停止，没有运行候选原生层、发布版浏览器端到端或安装程序打包。

唯一失败是 `settings-page.test.tsx` 中直接模式设置页标题的旧节点竞态：加载占位页与稳定页面都渲染“设置”，测试的异步查找偶尔返回随后被权威写作方式加载替换的占位标题，再对已脱离页面的节点检查可见性。产品按钮、模式写入和模型零调用断言没有失败。

最小修正先等待只在稳定直接设置页出现的“切换到专业模式”按钮，再同步检查一级标题、三个二级标题与普通界面禁词，并复用该按钮完成切换。没有修改产品、删除断言或增加全局时限。`pnpm --filter @inkshadow/desktop exec vitest run --config vitest.config.ts --configLoader runner src/pages/settings-page.test.tsx` 随后 1 个文件、58／58 通过，用时 68.63 秒；同一失败用例又独立连续复跑 5 次，5／5 通过。

这次定向通过没有被单独作为候选证据；最小修正提交 `cb97876894d6f02c4c901745c95533da7b0260fe` 随后从干净工作区完成整条候选与制品复核，两个命令均退出码 0。

### 远端持续集成、标签与公开回下载

- [远端运行 32604363119](https://github.com/gugubugugu0826/InkShadow/actions/runs/32604363119) 为 `completed/success`，绑定最终候选。云数据库 `97107172455` 用时 1 分 10 秒、质量 `97107172584` 用时 26 分、Windows `97107172588` 用时 25 分 2 秒，三项均成功。
- 带说明标签对象为 `37a40ddff9ea9aba27549f13f27718e319e2748e`，解析到最终候选。
- [v0.2.7 预发行](https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.7) 标题为“墨影 InkShadow v0.2.7 — 直接模式与数据安全修复工程预览版（未签名）”，发布时间 `2026-08-22T23:35:10Z`；`draft=false`、`prerelease=true`，公开页恰好三个附件。
- 全新目录 `D:\InkShadow\installer\v0.2.7-download-verification-20260822-233551` 回下载恰好三个文件；文件名、大小和摘要与候选一致，两行校验通过，下载清单提交等于标签解析提交。

### 尚未执行

- 真实供应商、真实凭据、真实付费调用和文学质量评估。
- 安装、启动、升级、卸载、重装、迁移和恢复的最终安装程序人工流程。
- 在另一台独立机器上的安装和运行。
- 真实 Windows 系统百分之二百缩放。
- 桌面 WebView 的输入法、权限、磁盘不足、并发和强制结束进程后的恢复。
- 系统保存对话框和外部打开。
- 百万字作品的真实长期压力；现有自动化基准不能替代长期使用验证。
- 代码签名、法律审查、隐私合规审查和正式更新通道。

完整修复时序见
[2026-08-22-V027-DIRECT-MODE-REMEDIATION.md](2026-08-22-V027-DIRECT-MODE-REMEDIATION.md)。

以下 `v0.2.6` 及更早结果为历史证据，不能作为 `v0.2.7` 或后续版本的通过依据。

## 2026-08-22 v0.2.6 最终候选、远端门禁与公开预发布

状态：`通过 / 已发布工程预览 / 外部条件阻塞`。

最终唯一发布源码为 `b744d042eeafdd9db586388d71e701b1d937f366`；标签对象
`f17fde56d83688bf6044a47c77794ebf0a46a936` 解析后精确指向该源码。发布时远端 `main` 亦为该提交；
发布后的文档提交可以使 `main` 前进，但标签与发布清单必须保持绑定该源码。

### 最终干净候选与分项结果

| 范围                         | 精确命令                                                     | 最终结果                                               |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| 完整未签名候选链             | `pnpm release:candidate:unsigned`                            | 退出码 0；来源、测试、构建、端到端和打包完整通过       |
| 全工作区测试                 | `pnpm test`                                                  | 472 个文件通过、16 个文件跳过；3,418 项通过、65 项跳过 |
| 桌面端（同一次全工作区运行） | `@inkshadow/desktop` 测试脚本                                | 266 个文件 / 2,095 项通过 / 1 项跳过 / 0 项失败        |
| 数据层（同一次全工作区运行） | `@inkshadow/data` 测试脚本                                   | 70 个文件 / 445 项通过 / 0 项失败                      |
| 网页端（同一次全工作区运行） | `@inkshadow/web` 测试脚本                                    | 4 个文件 / 33 项通过 / 0 项失败                        |
| 七项静态门禁                 | 格式、敏感信息、许可证、包边界、桌面发布配置、类型和代码规范 | 全部退出码 0                                           |
| 原生层                       | 格式、严格静态检查与 `cargo test`                            | 191 项通过 / 1 项按外部条件忽略 / 0 项失败             |
| 浏览器端到端                 | `pnpm test:e2e:release`                                      | 17/17 通过                                             |
| 正式网页构建                 | 候选链生产构建                                               | 2,286 个模块；58 个文件 / 7,068,735 字节               |

全工作区数字来自最终候选的一次完整运行，不与聚焦结果重复相加。被忽略的原生真实 Ollama 用例需要显式
外部环境，未被记为通过。

### 远端持续集成失败与最终通过

| 运行          | 结果                                                                                          | 处理与结论                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `32487324853` | 云数据库通过；Windows 原生因未使用的 `Kem` 导入失败；质量作业中第 73 版备份恢复用例超过 15 秒 | `6695474` 移除无用导入；`d407215` 把该真实文件恢复测试的本地上限改为 30 秒                                      |
| `32491014038` | Windows 原生与云数据库通过；质量作业中的同一恢复用例仍超过 30 秒                              | 两次实际时长约 36.9 秒和 64.5 秒且无断言不匹配；确认是 Windows 并行同步 SQLite 与完整迁移争用，不是产品恢复死锁 |
| `32497107722` | 全部成功：质量 `96818021976`、Windows `96818022324`、云数据库 `96818022362`                   | 最终提交只把数据层测试设为单工作线程；70 个文件 / 445 项、维护套件 50 项均通过，第 73 版恢复用例 19.873 秒      |

最终串行设置只作用于数据层测试运行器，不修改生产恢复逻辑，也没有继续放宽用例时限。

### 首次失败到分层复跑

| 阶段                 | 首次结果                                                    | 修复                                                                         | 复跑结果                                                            |
| -------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 开书页面高负载等待   | 首次全工作区运行有 2 项失败；默认 1 秒内仍显示 0/3 槽待结算 | 只把两项测试的最终状态等待上限局部设为 15 秒，不改变产品调用、重试或结算逻辑 | 聚焦 2/2 通过；随后 `pnpm test` 全工作区退出码 0                    |
| 数据层结构化原生错误 | 首次有 5 项失败                                             | 修正数据适配层包装错误对象时的结构化信息保留                                 | 数据层全量 70 个文件 / 445 项通过                                   |
| 原生层严格静态检查   | 首次报告 1 条测试结构体“先默认、后赋值”警告                 | 改为等价的结构体直接初始化                                                   | 格式与严格静态检查通过；原生层测试 190 项通过 / 1 项忽略 / 0 项失败 |
| 浏览器中文定位       | 首次 13/17，原因是测试仍查找旧英文文案                      | 更新普通界面中文和对应定位；第二次 16/17 后补齐最后一个遗漏                  | 最终 17/17，用时 26.1 秒；未删除或放宽断言                          |
| 第一次隔离真机启动   | `374b3ab` 程序启动后原生主线程栈溢出                        | 定界到自动备份与安全更新命令的大型异步状态，装箱命令边界和大型子任务         | `4ffa1ba` 程序不再栈溢出；原生层全量 190 项通过、1 项忽略           |
| 自动备份成功回执     | `4ffa1ba` 已生成完整文件，但前端把回执读取为“结果待核对”    | 原生返回对象按前端端口约定序列化为驼峰字段                                   | `722e67e` 首启直接进入成功；差量测试 19/19，文件独立恢复通过        |

### 最终候选的正式网页构建、指纹与浏览器端到端

最终候选的正式网页构建完成 2,286 个模块。输出与预算如下；所有上限保持不变。

| 指标       |         当前值 |           上限 |
| ---------- | -------------: | -------------: |
| 文件数     |             58 |              — |
| 物理大小   | 7,068,735 字节 |              — |
| 预算计数   | 7,067,935 字节 | 7,340,032 字节 |
| 入口文件   |   263,379 字节 |   307,200 字节 |
| 最大异步块 |   490,016 字节 |   512,000 字节 |
| 样式文件   |   128,880 字节 |   131,072 字节 |
| 工作线程   | 1,187,649 字节 | 1,572,864 字节 |

浏览器端到端为 17/17，且普通界面定位已经全部改为中文。发布清单记录的源码指纹为
1,241 个文件、21,134,076 字节，SHA-256
`3c1d7fb445752f92703ddb5d8722fb2d3592a65aa8917c30d17ebe84a5dbec95`；网页制品指纹为
58 个文件、7,068,735 字节，SHA-256
`b746b689c09e1f6cb9d2d4c1fb0199477be85d664be093cc4cd9a8a096122c4f`。环境指纹记录 0 个变量，
摘要为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。

此前正式构建在脏工作树清洁门按预期停止的证据继续保留；最终发布制品只采用后续干净源码提交
`b744d042eeafdd9db586388d71e701b1d937f366` 生成的结果。

### 凭据命名空间隔离

- 凭据服务名现在从 Tauri 应用标识派生；正式标识 `com.inkshadow.desktop` 的派生值保持不变。
- 隔离回归标识覆盖模型密钥、设备身份、项目密钥、云端会话和更新校验记录，不会访问正式命名空间。
- 本轮不迁移、复制或删除任何既有凭据；这项变更不新增数据库迁移。
- `722e67e` 真机程序使用独立应用标识、数据目录和凭据命名空间；正式五类凭据、正式数据库与正式用户目录
  均未读取或修改。云功能和安全更新配置在编译时关闭。

### 隔离 Windows Tauri 聚焦结果

聚焦程序绑定 `722e67e02c449b19ff5d215caf9e1aac12578b4f`，大小 25,886,208 字节，
SHA-256 `2c0e1da5d25bd2d881bf902b70d77ecc0aca8af55e99bbbbb2be9cc9f8f0a139`；它是未打包的
隔离真机程序，不是发布安装包。

| 缺陷 | 真机结果                                                                                                         | 数据证明与边界                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| D1   | 2 个作品、4 章，连续重载 3 次共 16 次章节观察，完整进程重启 2 次，均可读取                                       | 数据库 3,637,248 字节；完整性正常、外键违规 0；前后逻辑快照合同通过，正文、版本和摘要不变                              |
| D2   | 正常接受后正文 23→45 字、版本 4→5；双击产生 2 个界面事件但仍只新增 1 个版本                                      | 事务故障无部分写入；派生任务停在可重建状态且未回滚正文；锁等待 60 秒后强停，重启数据库摘要不变；主动取消未单独真机覆盖 |
| D3   | 旧的仅规划三槽安全结清为未发送、0 次发送；新批次为 1 成功、1 次 503 明确失败、1 次派发后连接失败并标为结果待核对 | 成功槽保留 852 字；页面重载和进程重启均新增发送 0，三条模型调用记录各尝试 1 次、自动重试 0                             |
| D4   | 正式界面接受 1 份就绪 AI 建议草稿后，今日清单第 2 版修订 5 成功，生成 3,653,632 字节备份；本用例模型调用增量 0   | 冻结源库与全新恢复库的 172 张表逐表差异 0，完整性正常、外键违规均为 0；两份昨日健康备份均保留                          |
| D5   | 取消确认 0 次发送、0 条调用；确认后恰好 1 次能力验证发送、1 条成功记录和 1 份绑定证据                            | 输入/输出词元 7/1；另有 1 次目录读取请求，不是模型生成调用，也不进入生成调用账本                                       |

D2 的主动取消，以及 D4 的权限拒绝、磁盘写入失败、目标竞争和写入中强制结束只由自动化覆盖，
尚未在最终安装包真机执行。

D4 先用空作品库完成清单修订 4、3,608,576 字节文件和 172 表独立恢复，随后通过正式界面接受
就绪 AI 建议草稿，把源库推进到 4 个作品、6 章、7 个不可变版本、1 份 AI 建议草稿、1 个后台任务、
4 条模型调用记录、2 个开书旅程和 9 轮问答。今日清单修订 5 的文件 SHA-256 为
`c98594980d258d0d11469a2d102f2f42575d073d854d3209719ee5aa02b96f04`；以启动前冻结的源库固定备份时点后，
全新恢复目录的 172 张表逐表 0 不一致，源库与恢复库完整性正常、外键违规均为 0，上述八类作者数据
均为非空且一致。两份昨日健康文件仍分别保持 3,637,248 字节 / `0a2d8a…c6ef` 和
3,682,304 字节 / `298b85…de5`。

首次把备份文件与仍在运行的源库比较时，`story_memory_policies` 在备份完成后因设置页初始化增加
1 行，比较按合同失败；证据保留在
`.tmp/v026-tauri-regression/evidence/backup-restores/d4-nonempty-due-restore/verification.json`。
改为“启动前冻结源库 → 今日备份 → 全新恢复目录”后通过，证据为
`.tmp/v026-tauri-regression/evidence/backup-restores/d4-nonempty-due-restore-source-freeze/verification.json` 和
`.tmp/v026-tauri-regression/evidence/backup-comparisons/d4-nonempty-final-contract.json`。这证明备份时点的
非空作者数据恢复，不把备份后可重建策略行的变化伪报成恢复损坏。

### 回环调用逐条对账

| 场景         | 结果       | 输入词元 | 输出词元 | 费用 |
| ------------ | ---------- | -------: | -------: | ---- |
| 固定能力验证 | 成功       |        7 |        1 | 未知 |
| 开书第 1 槽  | 成功       |      321 |      512 | 未知 |
| 开书第 2 槽  | 明确失败   |     未知 |     未知 | 未知 |
| 开书第 3 槽  | 结果待核对 |     未知 |     未知 | 未知 |

四次回环发送与四条模型调用记录逐条一致，已知合计为输入 328、输出 513 词元；完整总词元和费用
均为未知，没有估造。真实外部模型调用 0 次、输入/输出词元 0、费用 0，状态为“外部条件阻塞”。

### 最终安装程序、公开预发布与回下载

| 项目          | 最终证据                                                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装程序      | `InkShadow_0.2.6_x64-setup.exe`；7,654,178 字节；SHA-256 `c040f7861e3a25d0ca83cde85134ad2c7589e6f08e4a5e643eb8fcbcb3b0dd3a`；产品/文件版本 `0.2.6`；未签名       |
| 发布清单      | `inkshadow-release-manifest.json`；11,522 字节；SHA-256 `60a34e969a808e560ae8f4c587a4a5d5a96b225ca13cba2a8bddfb65580e78a3`                                       |
| 两行校验文件  | `SHA256SUMS`；194 字节；SHA-256 `bca03c0535f0953eb08643d4fb1824d911ccef57ca068e424ec128a9906a7cea`；对安装程序和发布清单校验通过                                 |
| 标签          | 标签对象 `f17fde56d83688bf6044a47c77794ebf0a46a936`；解析后为最终源码 `b744d042eeafdd9db586388d71e701b1d937f366`                                                 |
| GitHub 预发布 | <https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.6>；`publishedAt=2026-08-21T15:52:45Z`、`draft=false`、`prerelease=true`                          |
| 公开附件      | 恰好三个：唯一安装程序、发布清单和两行校验文件；发布说明不是附件                                                                                                 |
| 公开回下载    | 全新目录 `installer/v0.2.6-download-verification-20260822-015245`；三者文件名、字节和 SHA-256 与暂存一致；下载后的两行校验通过，清单 `gitCommitSha` 仍为最终源码 |

发布标题为“墨影 InkShadow v0.2.6 — Windows 真机稳定性修复工程预览版（未签名）”。标签和三个附件
均不得移动或静默替换；二进制或迁移有误时使用新的补丁版本。

### 尚未验证

- D1–D5 真机结论绑定 `722e67e` 的隔离 Windows Tauri 程序。为避免接触正式凭据管理器和正式用户数据，
  正式应用标识的最终安装程序没有启动。
- D2 主动取消，以及 D4 权限拒绝、磁盘写入失败、目标竞争和写入中强制结束，没有逐项在最终安装程序真机执行。
- 真实外部模型回归实际为 0 次、输入/输出词元 0、费用 0，仍为外部条件阻塞。
- 另一台电脑安装/升级/卸载、系统 200% 显示缩放、长期压力、外部应用打开、代码签名和商业发布审批仍未完成。

## 2026-08-20 v0.2.5 候选最终门禁

状态：`PASS / RELEASED_PREVIEW / BLOCKED_EXTERNAL`。

唯一来源提交 `5b3e212cafde10cd75fa87b7b74bfdfff9347a3d` 已完成完整源码门禁、clean-HEAD
`release:candidate:unsigned`、production benchmark、Windows NSIS 未签名打包、来源/制品 provenance、
main CI、annotated tag、GitHub Pre-release 与三个公开附件回下载。自动化只使用 fake/mock Provider 和
真实临时 SQLite，未读取真实 Key；因此发布 PASS 不会把真实 Provider、Windows Tauri/Wry 人工流程、
Credential Manager、系统 200% DPI、另一台电脑安装或四个外部应用打开升级为 PASS。独立实测使用
[`NEXT-UNRELEASED-WINDOWS-TAURI-PHASE-2-PROMPT.md`](NEXT-UNRELEASED-WINDOWS-TAURI-PHASE-2-PROMPT.md)。

### 最终 clean-HEAD、制品与远端证据

除另有说明，命令 cwd 均为 `D:\InkShadow`。

| 范围                      | 精确命令或来源                                                                                               | 最终结果                                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 唯一来源与指纹            | release manifest / clean HEAD                                                                                | `5b3e212cafde10cd75fa87b7b74bfdfff9347a3d`；1,238 files / 20,794,217 bytes；SHA-256 `c4260cc189a73c02a53aa0a8eca1b2012b55e77e24bb7ff0e11de5ccf4d27897`                                                                                                                                  |
| 完整源码门禁              | `pnpm.cmd release:check`                                                                                     | PASS；build、Prettier、秘密扫描、137 项许可证、20 包边界、17 项 Desktop 发布配置、全 workspace TypeScript、ESLint 与串行 workspace tests 全通过                                                                                                                                         |
| Desktop 最终全量          | clean-HEAD 候选内 `pnpm.cmd --filter @inkshadow/desktop test`                                                | PASS；265 files / 2,049 passed / 1 skipped / 0 failed；600.74 秒；唯一 skip 是显式外部依赖项                                                                                                                                                                                            |
| Rust / Tauri 严格门禁     | clean-HEAD 候选内 `pnpm.cmd check:rust`                                                                      | PASS；fmt、全 target clippy `-D warnings`；lib 169 passed / 1 ignored / 0 failed；ignored 为显式本地 Ollama 外部项                                                                                                                                                                      |
| Production Chromium       | clean-HEAD 候选内 `node scripts/run-e2e.mjs --dist apps/desktop/dist-release`                                | PASS；17/17；覆盖四宽度、等效 200%、DPR2、主题、Model Hub 长标识/URL/费用和本地安全链；不等于 Tauri WebView 或系统 DPI                                                                                                                                                                  |
| Production bundle         | clean-HEAD `dist-release` / release manifest                                                                 | PASS；59 files / 7,035,736 physical bytes；payload 7,034,936 / 7,340,032；入口 261,016 / 307,200，最大 async 481,776 / 512,000，CSS 128,810 / 131,072，worker 1,187,649 / 1,572,864 bytes；所有预算均未调整                                                                             |
| 发行前端指纹              | release manifest                                                                                             | 59 files / 7,035,736 bytes；SHA-256 `213370d1e2f57dc323203747997071cbee883ffc26cc35339ceec94758f9200d`                                                                                                                                                                                  |
| Production 长篇 benchmark | `INKSHADOW_SOURCE_REVISION=5b3e212cafde10cd75fa87b7b74bfdfff9347a3d pnpm.cmd benchmark:long-form:production` | PASS；2/2，8.29 秒；48 samples；JSON 371,204 bytes，SHA-256 `7b8eef0ed8bd544f23e7efabe74ad09ff187013404730cbec43c7c42d84ec1c5`，精确绑定来源提交                                                                                                                                        |
| Windows x64 NSIS          | `pnpm.cmd release:candidate:unsigned`                                                                        | `InkShadow_0.2.5_x64-setup.exe`；7,606,152 bytes；SHA-256 `f422467fa5fdff4236f3d453cb21de3927c89375e106ff372852f918079f20ad`；ProductVersion `0.2.5`；Authenticode `NotSigned`                                                                                                          |
| manifest / SHA256SUMS     | 候选输出与公开回下载                                                                                         | manifest 11,717 bytes / `4dce031a71eaa1664dcc993bd4f68362fb3d97b7843110b5ebc0b7c45b0bed0c`；`SHA256SUMS` 194 bytes / `0f4330efd42cd7d898497de2d0b6866fc2c9ba7b3533e8c11a233dd6a8439eec`                                                                                                 |
| main GitHub Actions       | run `32367317531`                                                                                            | PASS；Cloud PostgreSQL / forced RLS `96419578521`、Windows native `96419578642`、type/lint/test/web build `96419578743` 三项均为 success                                                                                                                                                |
| tag / Release / 回下载    | `v0.2.5` 公开远端复核                                                                                        | annotated tag object `51dfd64ba22e9771131f251cdc778ee06f89192d` peel 到来源提交；Release `draft=false`、`prerelease=true`，`publishedAt=2026-08-20T12:41:52Z`；三个公开附件重新下载后的文件名、字节和 SHA-256 均匹配：<https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.5> |

benchmark 的检索组为 Recall@K `0.666667`、Precision@K `0.597222`、MRR/nDCG/hit rate
`0.666667`、false inclusion `0.069444`；canon/stale/rejected/branch/POV/future leak 与 private leakage
均为 `0`，evidence/trace completeness 均为 `1`，平均 wall time `3.2295 ms`。Agent 组在确认前
0 dispatch；披露 2、fake dispatch 2、retry 0、hidden 0、duplicate 0，重启后无重发 1。该 JSON
不含真实 Provider 请求，也不代表文学质量或真实长篇付费调用。

### 候选冻结前的分项与失败→修复证据

下列分项发生在唯一来源提交冻结前，保留用于说明失败、修复与聚焦覆盖；它们不替代上方 clean-HEAD
候选证据，也不能单独外推为 Release PASS。
除表内另有说明，当前命令 cwd 均为 `D:\InkShadow`，且没有使用真实 Provider/Key。当前分项
交接没有保留统一 duration；未记录的时长不补造。最终发布结论只采用上方 source-bound 结果。

| 范围                              | 命令/证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 当前结果                                                                                                                                                                                    | 边界                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17 个共享包总运行                 | `pnpm.cmd --filter "./packages/**" --recursive --if-present --workspace-concurrency=1 run test`                                                                                                                                                                                                                                                                                                                                                                                                                                            | PASS；exit 0，17/21 workspace projects                                                                                                                                                      | 当前非冻结工作树分项；没有真实 Provider/Key。关键逐包数字见下列行，不能跨包相加成独立“总测试数”。                                                                                                                                                                                                                                                                                                                                                                                            |
| AI Core                           | 上述共享包总运行中的 `@inkshadow/ai-core`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | PASS；19 files / 129 tests                                                                                                                                                                  | 包含 Recall/Precision/MRR/nDCG/authority/stale/rejected/private 指标与固定 FTS/rerank fixture；不是最终 production benchmark。                                                                                                                                                                                                                                                                                                                                                               |
| Story Core                        | 上述共享包总运行中的 `@inkshadow/story-core`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | PASS；22 files / 134 tests                                                                                                                                                                  | 包含旧记忆显式提升合同；不等于真实长篇作品质量。                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Data                              | 上述共享包总运行中的 `@inkshadow/data`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | PASS；70 files / 432 tests                                                                                                                                                                  | 当前 Data 头为 `0070`，共 70 Data + 3 story-core；覆盖 fresh/upgrade/restart、maintenance `restoredTableCount=172`、planned invocation 与多粒度 FTS 范围合同；冻结候选仍须重跑。                                                                                                                                                                                                                                                                                                             |
| Import/Export                     | 上述共享包总运行中的 `@inkshadow/import-export`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | PASS；11 files / 90 tests                                                                                                                                                                   | 覆盖四格式真实图片结构与安全边界；不等于四个外部应用人工打开。                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Search Core                       | 上述共享包总运行中的 `@inkshadow/search-core`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | PASS；3 files / 34 tests                                                                                                                                                                    | 覆盖多粒度检索合同；不替代冻结 commit 上的 production benchmark。                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Application                       | 上述共享包总运行中的 `@inkshadow/application`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | PASS；8 files / 84 tests                                                                                                                                                                    | 覆盖应用用例层；不替代 Desktop 生产 E2E。                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| UI                                | 上述共享包总运行中的 `@inkshadow/ui`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | PASS；6 files / 42 tests                                                                                                                                                                    | 共享组件回归；不替代完整页面、响应式与系统缩放验收。                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 其余 10 个共享包                  | 同一共享包总运行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | PASS；`access-core` 4/30、`config` 1/13、`contracts` 12/67、`domain` 4/20、`observability` 1/9、`sync-core` 6/34、`task-engine` 3/16、`test-utils` 1/4、`cloud-client` 9/47、`platform` 1/5 | 与上方 7 个关键包属于同一次完整权限运行；全部 17 个 package scope 绿色，数字按 files/tests 记录，不能跨包累加成另一组独立测试。                                                                                                                                                                                                                                                                                                                                                              |
| Cloud API + Web                   | `pnpm.cmd --filter @inkshadow/cloud-api --filter @inkshadow/web --recursive --if-present --workspace-concurrency=1 run test`                                                                                                                                                                                                                                                                                                                                                                                                               | PASS；exit 0                                                                                                                                                                                | Cloud：21 files / 87 tests PASS，另 16 files / 64 tests 因外部 PostgreSQL 配置显式 skip；Web：4 files / 33 tests PASS。未使用真实 Provider/Key。                                                                                                                                                                                                                                                                                                                                             |
| 全 workspace TypeScript           | `pnpm.cmd typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | PASS；exit 0，20/21 workspace projects                                                                                                                                                      | 这是最新 Provider 收口前的 current-run 快照；收口后 Desktop 已单独复跑类型检查并通过，冻结候选仍须重新执行全 workspace、完整 Desktop/production build、E2E 与 release:check。                                                                                                                                                                                                                                                                                                                |
| Rust / Tauri                      | `pnpm.cmd check:rust`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | PASS；exit 0；fmt + clippy `-D warnings`；lib 169 passed / 1 ignored / 0 failed（完整 170 tests，119.10s），main/doc 0 tests                                                                | 包含 Tauri internal `73` 和原生导出保存用例；唯一 ignored 是显式本地 Ollama 外部项。本结果不等于安装版 WebView、Credential Manager 或系统 DPI，冻结候选仍须重跑。                                                                                                                                                                                                                                                                                                                            |
| 本地 query planning 聚焦          | `node_modules\.bin\vitest.CMD run apps/desktop/src/infrastructure/consistency-investigation-query-plan.test.ts --config apps/desktop/vitest.config.ts --configLoader runner --maxWorkers=1`                                                                                                                                                                                                                                                                                                                                                | PASS；1 file / 4 tests                                                                                                                                                                      | 最多 4 条/每条最多 80 字符、去重、确定性 fallback 与兼容字形保留；不是 content-free trace 或完整 Agent E2E。                                                                                                                                                                                                                                                                                                                                                                                 |
| 调查、修复恢复与只读任务图        | `.\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts --configLoader runner apps/desktop/src/infrastructure/consistency-investigation-service.test.ts apps/desktop/src/infrastructure/consistency-investigation-task-graph.test.ts apps/desktop/src/components/consistency-investigation-panel.test.tsx`                                                                                                                                                                                                              | PASS；3 files / 28 tests                                                                                                                                                                    | 这是披露加固前的同轮切片：fake gateway + 真实临时 SQLite 覆盖恢复、Candidate 隔离和 TaskGraph 重启/ambiguous；service/panel 的最新权威聚焦结果由下方 2 files / 36 tests 取代，TaskGraph 完整冻结复跑仍待。真实 Provider/Tauri 未跑。                                                                                                                                                                                                                                                         |
| 调查修复定向 ESLint               | `.\node_modules\.bin\eslint.cmd consistency-repair-candidate-recovery.ts consistency-repair-candidate-service.ts consistency-investigation-tauri-factory.ts consistency-investigation-service.test.ts`                                                                                                                                                                                                                                                                                                                                     | PASS                                                                                                                                                                                        | 只对应列出的当前文件。                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 调查与独立修复精确披露            | `pnpm.cmd --filter @inkshadow/desktop test src/infrastructure/consistency-investigation-service.test.ts src/components/consistency-investigation-panel.test.tsx`                                                                                                                                                                                                                                                                                                                                                                           | PASS；2 files / 36 tests                                                                                                                                                                    | 调查与 repair 各自明确本机/远程、连接显示名/精确模型、发送范围、1 call/0 retry、费用上限或“未知；提供方可能计费”，且授权互不复用；完整 inspection/capability/connection/privacy/context/messages 在确认后和 dispatch 前重检，route/价格/目的地/能力/正文/证据漂移均 0 Provider。最终 hook 的内部码为 `INVESTIGATION_DISCLOSURE_CHANGED` / `REPAIR_DISCLOSURE_CHANGED`，普通提示“本次发送 0 字，请重新查看范围与费用”，ledger 未派发；5 文件 ESLint/Prettier 通过，真实 Provider/Tauri 未跑。 |
| 续写 Provider 精确披露            | editor / continuation-generation-disclosure 聚焦 Vitest；Desktop typecheck；strict scoped ESLint                                                                                                                                                                                                                                                                                                                                                                                                                                           | PASS；31/31                                                                                                                                                                                 | 专业/直接续写的 prepare 0-call、普通 UI 精确目标/范围/去向/1 call/0 retry/费用、确认前与 Provider 边界前 fingerprint 复核、价格/路由漂移 0 dispatch 与 Candidate 隔离；真实 Provider 与最终全量 Desktop 均未跑。                                                                                                                                                                                                                                                                             |
| 开书 Provider 精确披露            | `.\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts --configLoader runner apps/desktop/src/pages/idea-journey-page.test.tsx apps/desktop/src/infrastructure/model-hub-creative-chain-integration.test.ts`                                                                                                                                                                                                                                                                                                           | PASS；exit 0；2 files / 79 tests；44.88s                                                                                                                                                    | 四类开书动作均覆盖二次确认、取消 0-call，以及 route/cost/source/privacy 的最终 Provider 边界复核；未使用真实 Provider/Key；其后已由上方 clean-HEAD Desktop 全量覆盖。                                                                                                                                                                                                                                                                                                                        |
| Settings 固定能力披露（前序切片） | `.\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts --configLoader runner apps/desktop/src/pages/settings-page.test.tsx apps/desktop/src/infrastructure/model-hub-task-capability-probe-disclosure.test.ts apps/desktop/src/infrastructure/model-hub-structured-capability-probe.test.ts apps/desktop/src/infrastructure/model-hub-translation-capability-probe.test.ts`                                                                                                                                            | PASS；exit 0；实际收集 3 files / 69 tests；49.08s                                                                                                                                           | 命令列出的 `model-hub-task-capability-probe-disclosure.test.ts` 当前未形成独立测试文件，Vitest 实际只收集其余 3 个文件；覆盖当前表单 destination、retry0、cost unknown、最终 identity 复核与 local→remote 目的地变化。下列 55-test 结果取代其 fixed-probe 最终结论。                                                                                                                                                                                                                         |
| Settings 固定 probe 最终披露      | `pnpm --filter @inkshadow/desktop test -- src/pages/settings-page.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                | PASS；1 file / 55 tests；51.54s                                                                                                                                                             | 两个固定、无作品内容入口完成点击冻结、content-free SHA-256 authority、同一 prepared input 持久化和 `gateway.generate` 前表单/fingerprint/权威身份重检；四类漂移 0 call、成功精确 1 call。豆包 Endpoint ID 非空时优先作为唯一有效模型，同一值进入普通披露、授权、catalog/connection 保存与派发；Provider dispatch surface 无剩余 P0/P1。Desktop typecheck 与 2-file ESLint/Prettier/diff 均 PASS。                                                                                            |
| 图片生成与普通编辑器披露          | `.\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts --configLoader runner apps/desktop/src/infrastructure/model-hub-image-generation-service.test.ts apps/desktop/src/components/model-hub-image-generation-panel.test.tsx apps/desktop/src/pages/editor-candidate-route.test.tsx`                                                                                                                                                                                                                                  | PASS；exit 0；3 files / 46 tests；18.91s                                                                                                                                                    | Prompt 变化会使旧确认失效且保持 0 invocation / 0 gateway；界面披露保留/训练、1 call / 0 retry，普通编辑器不显示 `connectionId`。真实 Provider 与全路由 DOM 扫描仍未跑。                                                                                                                                                                                                                                                                                                                      |
| Provider 面与普通 UI ID 审计      | `pnpm --filter @inkshadow/desktop test -- src/infrastructure/usage-center-service.test.ts src/pages/usage-center-page.test.tsx src/pages/task-center-page.test.tsx src/pages/project-checks-page.test.tsx`                                                                                                                                                                                                                                                                                                                                 | PASS；4 files / 22 tests                                                                                                                                                                    | 当前可达 Provider 面与安全关闭入口已逐项审计；Usage、通知/任务、检查页不显示 raw provider/project/chapter/version/connection/debug/fact/locator/aria ID，导航仍保留。受限沙箱首跑因无法读取 `@vitejs/plugin-react` startup error；相同命令完整权限复跑通过。7 文件 ESLint 首跑因依赖类型不可读产生 418 个连锁错误，完整权限复跑 0 error；Prettier/diff 首跑即 PASS。                                                                                                                         |
| 导入旧 Provider 入口关闭          | `.\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts --configLoader runner apps/desktop/src/pages/import-journey-page.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                      | 首次有效运行 exit 1，4 pass / 1 fail，8.61s；仅修正测试 fixture 后复跑 exit 0，1 file / 5 tests，8.08s                                                                                      | 首次 fixture 错把 continuation intent 用于导入整章接受，产品按策略安全拒绝；改为 whole-chapter `replace_document` Candidate 后，证明已保存历史隔离 Candidate 仍需显式接受，正文接受为 0 Provider 并创建新不可变版本。沙箱 plugin ACL 启动失败不计为产品运行；随后由本文顶部的完整 Desktop 265 files / 2,049 pass / 1 skip 结果覆盖。                                                                                                                                                         |
| 四格式图片导出                    | `pnpm.cmd --filter @inkshadow/import-export test`；PDF rasterizer 定向 Vitest                                                                                                                                                                                                                                                                                                                                                                                                                                                              | PASS；11 files / 90 tests；4/4                                                                                                                                                              | 真实解析 Markdown data URI、DOCX/EPUB media+关系和 PDF 图像页；覆盖 PNG CRC/JPEG 结构与尺寸/数量上限；不等于在 Word/阅读器/PDF 阅读器中人工打开。                                                                                                                                                                                                                                                                                                                                            |
| 导出保存回执                      | `export-artifact-download.test.ts` + `data-transfer-panel.test.tsx`；`native_export_artifact::tests`；`desktop-local-first` 导出用例                                                                                                                                                                                                                                                                                                                                                                                                       | PASS；Vitest 2 files / 16 tests；Rust 5/5；E2E 1/1                                                                                                                                          | 原生票据、目标身份、no-clobber/原子替换、写后回读 size+SHA、取消 0 写入、失败隐藏路径和浏览器诚实状态；真实 Windows 保存对话框仍 `BLOCKED_EXTERNAL`。                                                                                                                                                                                                                                                                                                                                        |
| Desktop / ImportExport TypeScript | `pnpm.cmd --filter @inkshadow/desktop typecheck`；`pnpm.cmd --filter @inkshadow/import-export typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                                   | PASS                                                                                                                                                                                        | Provider 审计的 Desktop 首跑在受限沙箱因读不到 `vite/client.d.ts` 报 TS6053，相同命令完整权限复跑通过；更早并行未收口快照的 6 个 `project-checks-page.tsx` 类型错误也已修复。ImportExport 为导出链分项结果；冻结源仍需最终重跑全 workspace。                                                                                                                                                                                                                                                 |
| 静态仓库与发布配置检查            | `pnpm.cmd check:secrets`；`pnpm.cmd check:boundaries`；`pnpm.cmd check:licenses`；`pnpm.cmd check:desktop-release`                                                                                                                                                                                                                                                                                                                                                                                                                         | PASS；四条均 exit 0；boundaries 20 packages；licenses 137 entries；desktop-release 17 tests / 40.17s                                                                                        | 最新复跑覆盖 secrets、20 包边界和 17 项 production Desktop 配置；licenses 137 为本轮较早的完整权限 current-run。它们不替代 production build、安装包、签名、CI 或 release:check。                                                                                                                                                                                                                                                                                                             |
| 导出链静态质量门禁                | scoped ESLint / Prettier / `git diff --check` / Desktop production build                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | PASS                                                                                                                                                                                        | 只证明该分项执行时的切片；不填写中间 build 字节，不替代冻结候选的完整 build/bundle/release 门禁。                                                                                                                                                                                                                                                                                                                                                                                            |
| Production 长篇 benchmark         | 冻结前仅完成 runner 接线                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 当时未运行；现已由上方 source-bound 2/2 PASS 取代                                                                                                                                           | 保留为候选冻结前的状态变化记录；最终有效值是 48 samples、8.29 秒和 SHA-256 `7b8eef0ed8bd544f23e7efabe74ad09ff187013404730cbec43c7c42d84ec1c5`。                                                                                                                                                                                                                                                                                                                                              |
| 静态视觉 manifest                 | `node scripts/check-visual-evidence.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | PASS；32 条记录 / 32 个唯一 PNG                                                                                                                                                             | dirty HEAD、static Chromium；`tauriWebView=not_run`、`systemScale=not_measured`。                                                                                                                                                                                                                                                                                                                                                                                                            |
| Candidate 决策聚焦                | `.\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts --configLoader runner apps/desktop/src/components/candidate-decision-navigation.test.ts apps/desktop/src/candidate-review-layout-css-contract.test.ts apps/desktop/src/components/story-planning-panel.test.tsx apps/desktop/src/pages/authoritative-extraction-page.test.tsx apps/desktop/src/pages/multi-agent-review-page.test.tsx apps/desktop/src/pages/governed-creative-extensions-page.test.tsx apps/desktop/src/pages/editor-candidate-route.test.tsx` | PASS；exit 0；7 files / 59 tests；28.15s                                                                                                                                                    | 覆盖共享 Candidate 决策导航、布局合同、规划/提取/Multi-Agent/创意扩展与编辑器路由；其后由上方 clean-HEAD Desktop 全量与 production Chromium 17/17 覆盖。                                                                                                                                                                                                                                                                                                                                     |
| Model Hub 最终 Chromium           | 新增 `tests/e2e/desktop-model-hub-reflow.spec.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 冻结前未运行；最终候选 3/3，完整 E2E 17/17 PASS                                                                                                                                             | 保留 fixture load-order 首次失败及修复记录；最终宽度/主题/DPR2/长 ID/URL/routes/cost 矩阵见上方 clean-HEAD 结果。                                                                                                                                                                                                                                                                                                                                                                            |
| Production build / bundle         | 冻结前等待最终重跑                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 最终 59 files / 7,035,736 bytes PASS                                                                                                                                                        | release manifest 记录 payload、入口、CSS、最大 async、worker 与 artifact fingerprint；预算未调整。                                                                                                                                                                                                                                                                                                                                                                                           |

完整 Desktop 当前工作树首次运行：

```powershell
pnpm.cmd --filter @inkshadow/desktop test
```

首次结果为 exit 1：265 files 中 260 passed / 5 failed；2,029 tests passed / 20 failed / 1 skipped，
582.10 秒。16 项集中失败是旧续写 fixture 只配置已关闭的 legacy profile，另外 4 项分别来自
多粒度索引计数、结构化规划测试 helper 错误吞掉真实 invalid-output rejection、固定 probe AST
作用域常量和原生 Candidate 旧 legacy fixture。收口时没有恢复 legacy Provider bypass：fixture 改为真实
Model Hub route，scope allowlist 只收紧不扩大，原生 Candidate 继续验证正文不变。过程中另确认并修复
一个真实回归：受治理的远程 Model Hub 方案此前无法在唯一阻塞为断网时进入安全离线待执行；当前只允许
冻结 inspection 为 remote 且 blocker 精确为 `NETWORK_OFFLINE` 的计划延迟，Prompt 仍不持久化，模糊
Provider timeout 仍为 `failed_final` 且不会隐藏重试。五个失败文件合并回归为 5 files / 75 tests PASS。

同一完整命令在修复后从头复跑为 exit 0：265 files / 2,049 passed / 1 skipped / 0 failed，
598.36 秒。唯一 skipped 仍是显式外部依赖项；没有真实 Provider/Key。冻结来源提交后，完整候选链
又从头得到 265 files / 2,049 passed / 1 skipped / 0 failed，600.74 秒；最终 Release PASS 采用后者。

候选冻结前的 production build 使用：

```powershell
pnpm.cmd --filter @inkshadow/desktop build:web
```

结果为 exit 0，2,285 modules，19.54 秒；59 个物理文件共 7,035,736 bytes，扣除 800-byte
`favicon.svg` 后门禁 payload 为 7,034,936 / 7,340,032 bytes，余量 305,096 bytes。入口
`index-DithMRvV.js` 为 261,016 / 307,200 bytes；最大 Agent 异步块
`consistency-investigation-tauri-factory-nQriBA6f.js` 为 481,776 / 512,000 bytes；主 CSS
`index-fgMRYSe-.css` 为 128,810 / 131,072 bytes；PDF worker 为 1,187,649 / 1,572,864
bytes。所有既有上限保持不变。clean-HEAD 候选重新构建得到相同字节，release manifest 记录
59 files / 7,035,736 bytes 与制品指纹
`213370d1e2f57dc323203747997071cbee883ffc26cc35339ceec94758f9200d`。

production Chromium 首次完整运行：

```powershell
node scripts/run-e2e.mjs --dist apps/desktop/dist
```

首次为 14 pass / 3 fail；三项都属于新增 Model Hub reflow fixture：runtime 已在首次页面载入时构造，
fixture 随后只写 localStorage，hash 导航没有重建内存 store，因此页面正确显示首次使用而旧测试找不到
连接选择器。修复 support 为写入后真实 reload，并把已加载目录的模型选择器对齐当前可访问名称“模型”；
没有放宽长供应商、长 URL、长模型、退役历史、费用、主题、四宽度、DPR2、等效 200% 或 overflow
断言。定向 3/3 后，同一完整命令复跑为 17/17 PASS，26.3 秒；clean-HEAD 候选的
`dist-release` 再次为 17/17 PASS。视觉 checker 随后为 32 records / 32 unique PNG PASS；静态视觉
manifest 仍诚实记录 dirty baseline、static Chromium、真实 Tauri 与系统 DPI 未运行，不能用候选
E2E 把这些人工边界升级为 PASS。

候选冻结前的工作树随后执行：

```powershell
pnpm.cmd release:check
```

结果为 exit 0：重新完成 20 个工作区 build、Prettier、秘密扫描、137 项运行时许可证、20 包架构
边界、17 项 Desktop 发布配置、全 workspace TypeScript、全仓 ESLint 和串行 workspace tests。
其中本次门禁内 Desktop 为 265 files / 2,049 passed / 1 skipped / 0 failed，600.58 秒；Web 为
4 files / 33 tests PASS，Cloud 默认运行 87 PASS / 64 external-PostgreSQL skip，其余包数字与上表一致。
这证明冻结前工作树已经通过源码级完整门禁。唯一来源提交随后又通过 clean-HEAD
`release:candidate:unsigned`：完整源码门禁、Rust 169 passed / 1 ignored、production Chromium
17/17、Tauri/NSIS 打包和 provenance 全部通过；候选 Desktop 为 2,049 passed / 1 skipped /
0 failed，600.74 秒。最终状态采用 clean-HEAD 结果，不把先前 dirty run 冒充发布制品。

Settings 固定 probe 加固保留以下失败→修复→复跑证据：首次 52-test 运行是 50 pass / 2 fail，均为旧文案断言；
更新后 54-test 运行是 51 pass / 3 fail，其中一个模型漂移 fixture 没有真正改变权威返回身份，另两个把发送后
落库冲突误投影为“未发送”；修正语义后为 53 pass / 1 fail，剩余 fixture 时序随后修复。聚焦 3/3 与完整
54/54（52.41s）通过。豆包有效模型补充用例的受限沙箱首跑因无法解析 `@vitejs/plugin-react` 而 0 tests；
获准环境首轮为 54 pass / 1 test-query fail，原因是 fixture 精确查找 `Endpoint ID`，而真实可访问名称含
“可选”。改为 `/^Endpoint ID/` 后聚焦 1/1，再完整 55/55 通过。受限 ESLint 同因类型依赖不可读产生
2557 个连锁假阳性，相同 2-file 命令在可读依赖环境复跑为 0 warning/error；这些是测试环境/fixture
失败，不是 Provider 产品调用失败。

最终 Settings 两文件静态命令（cwd `D:\InkShadow`）为：

```powershell
pnpm --filter @inkshadow/desktop typecheck
.\node_modules\.bin\eslint.cmd apps/desktop/src/pages/settings-page.tsx apps/desktop/src/pages/settings-page.test.tsx --max-warnings 0
.\node_modules\.bin\prettier.cmd --check apps/desktop/src/pages/settings-page.tsx apps/desktop/src/pages/settings-page.test.tsx
git diff --check -- apps/desktop/src/pages/settings-page.tsx apps/desktop/src/pages/settings-page.test.tsx
```

四条最终结果均为 PASS；ESLint 为 0 warning/error，Prettier 匹配 2 files，diff check 无输出。

共享包命令的受限沙箱首跑中，`access-core`、`ai-core`、`config`、`contracts`、`domain` 已通过，
随后 `import-export` 因沙箱无法读取 JSZip/PDF 依赖而报 `EPERM`。获准环境以同一命令从头复跑后，
17 个 package scope 全部通过；前一次是依赖 ACL 环境失败，不记作产品或测试用例失败，但保留在
本轮运行记录中。

Provider/UI ID 审计对同一组 7 文件执行的精确静态命令为：

```powershell
.\node_modules\.bin\eslint.cmd apps/desktop/src/infrastructure/usage-center-service.ts apps/desktop/src/infrastructure/usage-center-service.test.ts apps/desktop/src/pages/usage-center-page.test.tsx apps/desktop/src/pages/task-center-page.tsx apps/desktop/src/pages/task-center-page.test.tsx apps/desktop/src/pages/project-checks-page.tsx apps/desktop/src/pages/project-checks-page.test.tsx --max-warnings 0
.\node_modules\.bin\prettier.cmd --check apps/desktop/src/infrastructure/usage-center-service.ts apps/desktop/src/infrastructure/usage-center-service.test.ts apps/desktop/src/pages/usage-center-page.test.tsx apps/desktop/src/pages/task-center-page.tsx apps/desktop/src/pages/task-center-page.test.tsx apps/desktop/src/pages/project-checks-page.tsx apps/desktop/src/pages/project-checks-page.test.tsx
git diff --check -- apps/desktop/src/infrastructure/usage-center-service.ts apps/desktop/src/infrastructure/usage-center-service.test.ts apps/desktop/src/pages/usage-center-page.test.tsx apps/desktop/src/pages/task-center-page.tsx apps/desktop/src/pages/task-center-page.test.tsx apps/desktop/src/pages/project-checks-page.tsx apps/desktop/src/pages/project-checks-page.test.tsx
```

ESLint 受限沙箱首跑因依赖类型不可读产生 418 个连锁错误，相同命令完整权限复跑为 0 error；
Prettier 首跑即 PASS。`git diff --check` 首跑即 PASS，只出现无法读取用户级 Git ignore 的权限警告，
没有 whitespace finding。

以下章节均为 2026-08-14 及更早历史证据。

## 2026-08-13 发布后专项修复基线

在修改续写路由、开书状态机和 Model Hub 未连接界面之前运行：

```powershell
node node_modules/vitest/vitest.mjs run --config apps/desktop/vitest.config.ts --configLoader runner --maxWorkers=1 apps/desktop/src/infrastructure/generation-runtime.test.ts apps/desktop/src/infrastructure/model-hub-creative-chain-integration.test.ts apps/desktop/src/pages/idea-journey-page.test.tsx apps/desktop/src/pages/settings-page.test.tsx apps/desktop/src/infrastructure/diagnostics.test.ts
```

结果：`5 files / 126 tests PASS`，64.56 秒。该结果只证明修改前现有测试基线，不覆盖“Model Hub
有效但旧档案 selected model 为空”、每槽同步输入异常、方案选择状态门、真实缺口规划或局部路由
错误边界；也不是 Provider/Tauri 验收。首次沙箱内运行因外部 `node_modules` junction 权限无法解析
React 插件，随后在已批准的工作区依赖上下文中复跑成功；工具环境失败不计为用例失败。

## 2026-08-13 v0.2.3 真实反馈与 v0.2.4 已发布修复证据

下表的源码自动化仍不能替代真实平台验收。远端只读审计另行确认 `v0.2.4` 已公开为
Pre-release；合法结论是
**`RELEASED_PREVIEW / CODE_FIXED_AUTOMATION / REAL_TAURI_NOT_RETESTED / PROVIDER_LIVE_NOT_RUN`**。

| 证据层                        | 当前覆盖                                                                                                                                                                                                                                                                        | 结论                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 严格 fake/mock gateway        | Candidate 接受以及接受/保存/恢复后的持久后台管线均为 0 次模型调用；旧队列中的云阶段开关也会被清洗。开书合法生成批次断言精确 3 次调用，选择/确定性规划/回答断言 0 次，并覆盖全成功、部分失败、取消、结果不明确和失败原因；Model Hub 基础 readiness 漂移与当前章节 preflight 阻断 | 新增回归只证明本地管线、派发编排、门禁和隔离候选，不证明 Provider 兼容性或文学质量。云摘要/识别在独立授权状态机完整前不可派发       |
| 真实临时 SQLite               | 接受 Candidate 事务保存新正文/新不可变版本、旧版不变、本地派生失败不回滚、重启后 0 自动模型调用；凭据删除后重绑、退役与同供应商新建、历史 invocation 保留；开书 `reserved/bound/dispatched` 崩溃点和终态恢复                                                                    | Data `0065` 只新增不含内容的 `provider_dispatch_started_at`；已发布迁移和 checksum 未改写                                           |
| production Chromium           | 1440/1280/1024/800、200% zoom、DPR2、窄屏 Drawer、焦点返回/Escape、44px 目标和水平 overflow；Shell/Model Hub 显示无正文的基础 readiness，当前章节 blocked preflight 会覆盖顶栏                                                                                                  | 只是 Chromium CSS viewport 证据；不得把 CSS zoom/DPR2 写成 Windows 系统 200% DPI                                                    |
| Windows Tauri + Provider live | v0.2.4 已发布修复版尚未使用真实 Key、Credential Manager、Wry 或真实 DeepSeek 复测                                                                                                                                                                                               | `NOT_RUN / REAL_TAURI_NOT_RETESTED`；按[二阶段 Prompt](RELEASE_CHECKLIST.md#v024-修复版第二阶段真实-windows-tauri-测试-prompt) 执行 |

### production bundle graph 与预算（最终当前构建）

审计未发现重复 React/runtime/PDF/ZIP/付费评测模块，未发现应懒加载的付费评测或 PDF 同时进入
普通启动图，也未发现 source map、HMR 或测试代码进入 production bundle。因此本次只把
内部总量回归门禁从 `6 MiB + 416 KiB = 6,717,440 bytes` 调整为
`7 MiB = 7,340,032 bytes`；不通过排除异步包或迁移到不计量位置规避检查。

最终构建仍会报告 DOCX、EPUB、PDF exporter 同时存在动态和包根静态引用；逐产物检查证明三份
实现各只出现一次，并统一落在按路由加载的 `import-journey-page` chunk，没有进入
`index.html` 的普通启动 preload，也没有重复总量。其影响是进入设置/导入路由时会一并加载三个
exporter，动作级懒加载没有单独分包；这是后续 bundle hardening，而不是本次 7 MiB 调整的依据
缺口。JSZip、PDF rasterizer 和付费评测 factory 仍保持独立按需 chunk。

| 指标                                     |      最终 production build |                                          门禁 |
| ---------------------------------------- | -------------------------: | --------------------------------------------: |
| 前端 payload（不含 800-byte favicon）    |            6,739,000 bytes |      总量 7,340,032 bytes，余量 601,032 bytes |
| 全部发行前端文件（含 favicon）           | 53 files / 6,739,800 bytes | 物理总量对同一预算仍有 600,232 bytes 可用余量 |
| 入口 chunk `index-Up6b06Qb.js`           |              267,401 bytes |                       300 KiB = 307,200 bytes |
| 最大异步 chunk `runtime-U-oR9CDm.js`     |              498,767 bytes |                       500 KiB = 512,000 bytes |
| `desktop-local` 启动共享 chunk           |              477,450 bytes |                       500 KiB = 512,000 bytes |
| `model-hub-store-runtime` 启动共享 chunk |              127,403 bytes |                       500 KiB = 512,000 bytes |
| CSS                                      |              131,053 bytes |                       128 KiB = 131,072 bytes |
| PDF worker                               |            1,187,649 bytes |                   1,536 KiB = 1,572,864 bytes |

入口 300 KiB、异步 chunk 500 KiB、CSS 128 KiB、worker 1,536 KiB 和通用资产 2 MiB
的单文件上限全部保持不变。CSS 距上限只剩 19 bytes，后续样式增长必须先消除重复，
不得再用总量预算调整掩盖单文件风险。
最终 payload 若继续使用旧 `6,717,440` byte 门禁会超出 21,560 bytes；把 800-byte favicon 也计入
物理总量时超出 22,360 bytes。经上述生产依赖图审计后，新 `7,340,032` byte 门禁分别保留
601,032 bytes payload 余量与 600,232 bytes 物理总量余量。该结果是 `v0.2.4` 已发布源码的最终
production build 证据；它本身不替代 NSIS 与 Release 元数据。公开制品事实见
[`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md#v024-已发布-pre-release-中文说明与追踪)。

### 当前已完成的项目级门禁

| 门禁                 | 命令                                                                                                            | 结果                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Desktop 最终全量     | `pnpm.cmd --filter @inkshadow/desktop test`                                                                     | PASS；249 files / 1,855 passed / 1 skipped / 0 failed                                                                        |
| Data 最终全量        | `pnpm.cmd --filter @inkshadow/data test`                                                                        | PASS；421 passed / 0 failed                                                                                                  |
| Desktop TypeScript   | `pnpm.cmd --filter @inkshadow/desktop typecheck`                                                                | PASS                                                                                                                         |
| Rust/Tauri 原生门禁  | `pnpm.cmd check:rust`                                                                                           | PASS；`cargo fmt`、全 target `clippy -D warnings` 与测试完成，160 passed / 1 ignored / 0 failed；测试 80.14 秒，整体 92.1 秒 |
| Production build     | `pnpm.cmd --filter @inkshadow/desktop build`                                                                    | PASS；53 files / 6,739,800 bytes；预算与最大 chunks 见上表                                                                   |
| production 响应式    | `node scripts/run-e2e.mjs --dist apps/desktop/dist tests/e2e/desktop-production-reflow.spec.ts --reporter=line` | 3/3 PASS；不等于真实 Tauri/DPI                                                                                               |
| local-first 安全边界 | `node scripts/run-e2e.mjs --dist apps/desktop/dist tests/e2e/desktop-local-first.spec.ts --reporter=line`       | 4/4 PASS；只使用本地/测试数据                                                                                                |
| 最终 Chromium 合计   | 相关 production Chromium 套件                                                                                   | 12/12 PASS：11 项直接通过；导入/导出 1 项首次受本机 `pdfjs` ACL 阻断，在沙箱外同一代码路径复跑通过；不等于 Tauri WebView     |

全仓 `pnpm.cmd release:check` 最终退出码为 0，用时 924.9 秒。它从当前工作树重新完成
20 个工作区的 production build、Prettier、秘密扫描、137 项运行时许可证、20 包架构边界、
17 项 Desktop 发布配置、全部工作区 TypeScript、ESLint 和串行测试；测试合计
3,132 passed / 65 skipped / 0 failed。该 PASS 证明 `v0.2.4` 已发布源码当时的工程门禁，但不等于
真实 Provider 或 Windows Tauri 复测。最终 `git diff --check` 也为 PASS；远端只读审计确认来源
commit/tag peel、Pre-release 状态和三项公开附件，精确值见
[`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md#v024-已发布-pre-release-中文说明与追踪)。

## 2026-08-13 Model Hub、正文布局与 Novel Skill 受限 smoke

### 聚焦回归

```powershell
node_modules\.bin\vitest.CMD run apps/desktop/src/infrastructure/model-hub-page-hydration.test.ts apps/desktop/src/infrastructure/model-hub-ui-diagnostics.test.ts apps/desktop/src/infrastructure/model-hub-connection-intent.test.ts apps/desktop/src/infrastructure/selectable-model-catalog-registry.test.ts apps/desktop/src/components/model-hub-selectable-catalog-browser.test.tsx apps/desktop/src/editor-layout-css-contract.test.ts apps/desktop/src/pages/editor-workspace-simplification.test.tsx apps/desktop/src/infrastructure/novel-skill-sqlite-store.test.ts apps/desktop/src/infrastructure/generation-runtime.test.ts apps/desktop/src/pages/settings-page.test.tsx --config apps/desktop/vitest.config.ts --configLoader runner --maxWorkers=1
```

结果：最终 `10 files / 118 tests PASS`，65.30 秒。覆盖：

- 跨 mount 唯一 operation 身份、真实 effect 顺序诊断时间、5 秒凭据摘要超时、缓存保留、迟到结果隔离及停用连接排除；
- 版本化官方候选目录的 22 项任务覆盖、普通投影、账户目录优先、全局/任务级浏览器与内容无关连接 intent；
- 宽屏可访问 separator、1024px 及以下 Drawer、800px compact drawer 和 44px 直接操作目标；
- 真实临时 SQLite 的 Novel Skill 启用→重启保留→关闭→重启关闭；一次 mocked 200–400 中文字符生成只进入隔离 Candidate，正文和不可变版本不变，拒绝及历史 trace 可跨重开保留。

Novel Skill 两个文件在上述聚焦命令中为 `2 files / 28 tests PASS`。该 smoke 使用本地 mock，零网络、
零真实 Provider、零付费评测调用；它不证明写作质量，不允许把任何 Core/Genre 改为默认启用。

### v0.2.3 发布提交工程门禁

| 范围                           | 精确命令                                                                                                                                             | 结果                                                                                                                              | 状态                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Desktop 全量                   | `pnpm.cmd --filter @inkshadow/desktop test`                                                                                                          | 242 files；1,793 passed / 1 skipped / 0 failed；590.96 秒                                                                         | PASS                                |
| Desktop TypeScript             | `pnpm.cmd --filter @inkshadow/desktop typecheck`                                                                                                     | 退出码 0；26.4 秒                                                                                                                 | PASS                                |
| Production build               | `pnpm.cmd --filter @inkshadow/desktop build`                                                                                                         | 2,244 modules；21.03 秒；Settings chunk 214.38 KiB；runtime 495.62 / 512 KiB                                                      | PASS                                |
| Rust 原生严格门禁              | `pnpm.cmd check:rust`                                                                                                                                | 退出码 0；`cargo fmt --check`、全 target `clippy -D warnings`、完整测试通过；160 passed / 1 ignored / 0 failed；测试阶段 84.03 秒 | PASS                                |
| 响应式 production Chromium     | `node scripts/run-e2e.mjs --dist apps/desktop/dist tests/e2e/desktop-production-reflow.spec.ts tests/e2e/desktop-responsive.spec.ts --reporter=line` | 6/6；覆盖 1440/1280/1024/800、200% 与 DPR2                                                                                        | PASS；不等于 Tauri WebView          |
| 视觉矩阵                       | production Chromium 浏览器预览                                                                                                                       | 1536/1440/1280/1024/800、125%/150%/200% 等效视口、代表性明暗主题；未发现新的横向溢出、右侧裁切或不可达主操作                      | PASS；真实 Tauri/DPI `NOT_VERIFIED` |
| Windows Tauri + SQLite/Keyring | 未执行                                                                                                                                               | 当前代码的冷启动、离开/返回、睡眠恢复、凭据超时故障注入与连接返回仍无真实 WebView 证据                                            | NOT_RUN / NOT_VERIFIED              |
| 真实 Provider / Skill A/B      | 明确未执行                                                                                                                                           | DeepSeek/其他真实供应商、192 次付费调用与 2,496 项人工评分均为 0；全部实验 Skill 保持 `defaultEnabled=false`                      | NOT_RUN / KEEP_DISABLED             |
| 完整未签名候选链               | `CI=true pnpm.cmd release:candidate:unsigned`                                                                                                        | 退出码 0；1,290.7 秒；来源提交、Rust、production Chromium E2E、NSIS、manifest 与 provenance 全部通过                              | PASS                                |
| PR GitHub Actions              | run `31679607622`                                                                                                                                    | quality、Windows native、Cloud PostgreSQL 三项均通过                                                                              | PASS                                |
| `main` GitHub Actions          | run `31681304602`                                                                                                                                    | quality、Windows native、Cloud PostgreSQL 三项均通过                                                                              | PASS                                |
| GitHub `v0.2.3` Release        | 标签与公开附件复核                                                                                                                                   | tag peel 为 `3abdcfeb327567c632e440d55d11f0af6f4911d2`；Release 为公开 Pre-release；三个附件摘要与本地校验一致                    | PASS                                |

首次在受限沙箱启动 Vitest/TypeScript 时，Windows pnpm junction 目标不可读，分别在 React 插件与
`vite/client.d.ts` 解析阶段退出；这两次尝试没有进入断言或源码类型检查。允许读取工作区实际依赖链接后，上述
聚焦测试、全量测试和类型检查通过。该工具环境失败保留在记录中，不改写为代码测试失败，也不从最终结果中删除。

候选准备阶段另有三次失败均保留：来源门禁先拒绝源码目录旁生成的 Vitest 缓存；全仓 Prettier 随后发现
本地 `.qoder/` 知识库会被误扫；首次完整顺序测试又由共享 UI 合同发现
`--editor-assistant-width` 缺少局部默认定义。前两项通过明确忽略本地知识库并清除生成缓存解决，未删除或
格式化用户内容；第三项在 `.editor-workspace` 增加与原 fallback 相同的响应式默认值，并由共享 UI
`42/42`、编辑器布局与交互 `11/11` 以及上述 Desktop 全量 `1,793 passed / 1 skipped / 0 failed` 验证。没有跳过断言、放宽预算或抬高超时。

公开 Release：<https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.3>，发布时间
`2026-08-13T08:45:32Z`。公开安装包为 7,469,168 bytes，SHA-256
`23413b1bf874e1b25ab77cd156cff75472744c0e73ec830fb83ef98048ea2bb4`；manifest 为 10,167 bytes，
SHA-256 `cd047a59e2bbb13e71f4263ba86feffab115cf47d7d9f7b396ab5d2d56111417`；`SHA256SUMS` 为
194 bytes，SHA-256 `89ad2c671bdaefa05bb4bbb1d0f6c37cdbbbd4a4e22d53cb7eef95a750def466`。三个附件均已从公开 Release 回下载并复核一致。

## 2026-08-12 v0.2.2 已发布候选与远端门禁

| 范围                    | 精确命令                                                                                                                             | 结果                                                                                                                                                                                                                                              | 状态 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 完整工程门禁            | `pnpm.cmd release:check`                                                                                                             | 退出码 0；1,459.6 秒；生产构建、格式、秘密扫描、137 项运行时许可证、20 包边界、17 项 Desktop 发布配置、全部工作区类型检查、ESLint 和 20 个测试范围通过；合计 3,035 passed / 65 skipped / 0 failed                                                 | PASS |
| Desktop 全量            | `pnpm.cmd --filter @inkshadow/desktop test`                                                                                          | 238 files；1,759 passed / 1 skipped / 0 failed；559.30 秒                                                                                                                                                                                         | PASS |
| 付费评测 infrastructure | `node node_modules/vitest/vitest.mjs run --config apps/desktop/vitest.infrastructure.config.ts --configLoader runner --maxWorkers=1` | 10 files / 96 tests                                                                                                                                                                                                                               | PASS |
| Rust 严格门禁           | `pnpm.cmd check:rust`                                                                                                                | format、全 target `clippy -D warnings` 和完整测试通过；160 passed / 1 ignored / 0 failed；101.5 秒                                                                                                                                                | PASS |
| Production Chromium     | `pnpm.cmd test:e2e`                                                                                                                  | production build 后 11/11；覆盖 1440/1280/1024/800、200% zoom、DPR2、本地项目生命周期、恢复/Candidate、导入导出与同步关闭；总耗时 73.8 秒                                                                                                         | PASS |
| 当前生产构建体积        | `pnpm.cmd --filter @inkshadow/desktop build`（由最终 `release:check` 与 E2E 重建）                                                   | 2,240 modules；Vite payload `6,651,786 / 6,717,440` bytes；普通 runtime `495,618 / 512,000`；付费异步 factory `287,543 / 512,000`；物理 `dist` 含 800-byte favicon 共 6,652,586 bytes                                                             | PASS |
| v0.2.2 唯一提交         | `git rev-parse HEAD`                                                                                                                 | `7dd746e7b35d07f9ae9605738d16dd852fd513a4`；PR #2 merged exact SHA；源码指纹 1,143 files / 18,948,527 bytes，SHA-256 `f6eea0d621dde929775a878319baf351c361cd05ca257ad8a9e11096468f2ddd`                                                           | PASS |
| v0.2.2 干净候选链       | `CI=true pnpm.cmd release:candidate:unsigned`                                                                                        | 退出码 0；1,303.3 秒；未签名 NSIS、manifest 与来源复核通过；本地候选安装包 7,457,530 bytes，SHA-256 `4157bcd289522533eefee970aabc533eb4907d48cc57d97d8f5ef464fce7bfe5`                                                                            | PASS |
| PR #2 GitHub Actions    | run `31500721439`                                                                                                                    | quality 22m38s、Windows native shell 22m41s、Cloud PostgreSQL 1m03s；三项均通过                                                                                                                                                                   | PASS |
| `main` GitHub Actions   | run `31502928893`                                                                                                                    | quality 21m16s、Windows native shell 22m32s、Cloud PostgreSQL 56s；三项均通过                                                                                                                                                                     | PASS |
| GitHub v0.2.2 Release   | `gh release view v0.2.2 --repo gugubugugu0826/InkShadow`                                                                             | annotated tag object `706b7d211f651e2a5eabdd738a79b93ff5ce10f0` 指向发布提交；`draft=false`、`prerelease=true`；公开 main CI 安装包 7,458,168 bytes、SHA-256 `3048198c44bcb79ad240642ce81e698d499bfbf0bf443a62099d0a57ac5c128c`，三个附件回读一致 | PASS |

最终 PASS 之前保留了失败证据：一次并行 workspace 聚合以退出码 1 结束且子包输出被 pnpm 管道隐藏；改用串行 workspace 后，定位到 Web 加密测试在三次真实 310,000 轮 PBKDF2 加上逐字输入时于 5.029 秒超时。等价的测试输入改为单次 change 后，真实加密、错误恢复材料拒绝、锁定和正确材料解锁断言均保留。随后一轮只剩 Story Governance 首个懒加载标题的默认 1 秒等待失败；仅为该首次加载点增加 5 秒局部等待。最终完整 `release:check` 通过，失败记录没有被删除或改写为通过。

PR #2 的早期 run `31489739451` 与 `31494223973` 也继续保留为失败记录：两次 Cloud 和 Windows
native 作业通过，quality 作业在受限 Windows runner 上超时；最终修复保持断言和单项 timeout，
串行执行 Desktop 测试文件并加固临时 SQLite 清理。随后 exact-SHA run `31500721439` 三项通过。

上述 Chromium 证据不是 Tauri WebView 交互、真实 DeepSeek、真实付费评测或另一台电脑安装证据。
公开 `v0.2.2` 是不可静默替换的未签名 Pre-release：
<https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.2>。此前 `test:e2e:release` 的
clean-worktree 拒绝只证明来源安全门正常工作；最终发布证据以上表的独立候选链为准。

## 2026-08-11 付费评测本地基础设施最终快照

本节所有 provider 依赖均为 fake/stub；没有读取 Key、没有商业授权、没有网络模型调用，也没有把
fake 输出写成真实观察值。

| 范围                             | 精确命令                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 结果                     | 状态 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---- |
| 0063/0064 Desktop infrastructure | `node node_modules/vitest/vitest.mjs run --config apps/desktop/vitest.infrastructure.config.ts --configLoader runner --maxWorkers=1`                                                                                                                                                                                                                                                                                                                                                                                                         | 10 files / 96 tests      | PASS |
| Data 付费迁移与恢复攻击组        | `node ..\..\node_modules\vitest\vitest.mjs run tests/novel-skill-paid-runner-migration.test.ts tests/maintenance.test.ts --config vitest.config.ts --configLoader runner --maxWorkers=1`（工作目录 `packages/data`）                                                                                                                                                                                                                                                                                                                         | 2 files / 65 tests       | PASS |
| Desktop TypeScript               | `node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json --pretty false`                                                                                                                                                                                                                                                                                                                                                                                                                                                 | exit code 0              | PASS |
| Data TypeScript                  | `node node_modules/typescript/bin/tsc --noEmit -p packages/data/tsconfig.json --pretty false`                                                                                                                                                                                                                                                                                                                                                                                                                                                | exit code 0              | PASS |
| Tauri 迁移 62→67 与重启          | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml local_migrations::tests --lib --no-fail-fast`                                                                                                                                                                                                                                                                                                                                                                                                                                  | 10 passed / 151 filtered | PASS |
| 非付费接线独立终审               | `node node_modules/vitest/vitest.mjs run --config apps/desktop/vitest.config.ts --configLoader runner apps/desktop/src/infrastructure/novel-skill-paid-evaluation-coordinator.test.ts apps/desktop/src/infrastructure/novel-skill-paid-evaluation-runtime.test.ts apps/desktop/src/infrastructure/novel-skill-paid-evaluation-runner.test.ts apps/desktop/src/infrastructure/model-hub-exact-evaluation-target.test.ts apps/desktop/src/components/novel-skill-paid-evaluation-panel.test.tsx apps/desktop/src/pages/settings-page.test.tsx` | 6 files / 80 tests       | PASS |
| 盲评与归档隔离独立终审           | `node node_modules/vitest/vitest.mjs run --config apps/desktop/vitest.config.ts --configLoader runner apps/desktop/src/infrastructure/novel-skill-paid-blind-review-service.test.ts apps/desktop/src/infrastructure/novel-skill-paid-evaluation-archived-project.test.ts`                                                                                                                                                                                                                                                                    | 2 files / 27 tests       | PASS |
| 运行中取消回归                   | `node node_modules/vitest/vitest.mjs run apps/desktop/src/components/novel-skill-paid-evaluation-panel.test.tsx --config apps/desktop/vitest.config.ts --configLoader runner --maxWorkers=1`                                                                                                                                                                                                                                                                                                                                                 | 1 file / 6 tests         | PASS |
| Model Hub hydration / 设置       | `node node_modules/vitest/vitest.mjs run apps/desktop/src/infrastructure/model-hub-page-hydration.test.ts apps/desktop/src/infrastructure/model-hub-ui-diagnostics.test.ts apps/desktop/src/infrastructure/diagnostics.test.ts apps/desktop/src/pages/settings-page.test.tsx --config apps/desktop/vitest.config.ts --configLoader runner --maxWorkers=1`                                                                                                                                                                                    | 4 files / 55 tests       | PASS |
| AI Core 全量                     | `node ..\..\node_modules\vitest\vitest.mjs run tests --configLoader runner --maxWorkers=1`（工作目录 `packages/ai-core`）                                                                                                                                                                                                                                                                                                                                                                                                                    | 16 files / 120 tests     | PASS |
| AI Core / Domain TypeScript      | `node node_modules/typescript/bin/tsc -p packages/ai-core/tsconfig.json --pretty false`；`node node_modules/typescript/bin/tsc -p packages/domain/tsconfig.json --pretty false`                                                                                                                                                                                                                                                                                                                                                              | 两项 exit code 0         | PASS |

独立 Store 审查另复跑 Store + migration 36/36、真实 SQLite integration 5/5、maintenance 49/49，结论为
`APPROVE`，P0/P1/P2 均为 0。该批准范围是内容无关的账本、派发权威、零自动调用与恢复语义，不是小说
Skill 写作增益。真实状态仍为：

```text
status = NOT_EVALUATED
observationCount = 0
manualScoreCount = 0
defaultEnablement = KEEP_DISABLED
```

## 2026-08-10 历史融合增量聚焦验证（含已批准的 `0061` 账本基础设施）

| 范围                                 | 精确命令                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 结果                           | 状态 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---- |
| Model Hub hydration / 设置           | `.\node_modules\.bin\vitest.cmd run --config apps\desktop\vitest.config.ts --configLoader runner apps\desktop\src\infrastructure\model-hub-page-hydration.test.ts apps\desktop\src\infrastructure\model-hub-ui-diagnostics.test.ts apps\desktop\src\infrastructure\diagnostics.test.ts apps\desktop\src\pages\settings-page.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 4 files / 54 tests；37.24 秒   | PASS |
| 续写、上下文、摘要与推荐             | `.\node_modules\.bin\vitest.cmd run --config apps\desktop\vitest.config.ts --configLoader runner apps\desktop\src\components\generation-progress-panel.test.tsx apps\desktop\src\components\context-history-panel.test.tsx apps\desktop\src\components\chapter-summary-panel.test.tsx apps\desktop\src\infrastructure\chapter-summary-service.test.ts apps\desktop\src\infrastructure\editor-continuation-preference.test.ts apps\desktop\src\infrastructure\generation-runtime.test.ts apps\desktop\src\infrastructure\model-hub-translation-capability-probe.test.ts apps\desktop\src\infrastructure\model-hub-task-recommendation.test.ts apps\desktop\src\infrastructure\model-hub-structured-capability-probe.test.ts apps\desktop\src\infrastructure\model-hub-chapter-summary-model.test.ts apps\desktop\src\infrastructure\model-hub-execution-service.test.ts apps\desktop\src\infrastructure\model-hub-provider-registry.test.ts apps\desktop\src\infrastructure\model-hub-router.test.ts` | 13 files / 119 tests；10.80 秒 | PASS |
| 开书、Skill opt-in 与 Candidate 围栏 | `.\node_modules\.bin\vitest.cmd run --config apps\desktop\vitest.config.ts --configLoader runner apps\desktop\src\pages\idea-journey-page.test.tsx apps\desktop\src\infrastructure\model-hub-creative-chain-integration.test.ts apps\desktop\src\infrastructure\novel-skill-runtime.test.ts apps\desktop\src\infrastructure\novel-skill-sqlite-store.test.ts apps\desktop\src\components\novel-skill-panel.test.tsx apps\desktop\src\infrastructure\context-trace-output-commit.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 6 files / 77 tests；24.50 秒   | PASS |
| AI Core 输出、恢复与 Context Budget  | `..\..\node_modules\.bin\vitest.cmd run tests\task-output-profile.test.ts tests\continuation-recovery.test.ts tests\context-compiler.test.ts tests\preflight.test.ts --configLoader runner`（工作目录 `packages/ai-core`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 4 files / 42 tests；440 毫秒   | PASS |
| Data `0061` 迁移与恢复攻击组         | `..\..\node_modules\.bin\vitest.cmd run tests\novel-skill-evaluation-migration.test.ts tests\maintenance.test.ts --config vitest.config.ts --configLoader runner`（工作目录 `packages/data`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 2 files / 22 tests；9.85 秒    | PASS |
| Novel Skill 评估器                   | `..\..\node_modules\.bin\vitest.cmd run tests\novel-skill.test.ts --configLoader runner`（工作目录 `packages/ai-core`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 1 file / 17 tests；639 毫秒    | PASS |
| Desktop 评测账本 Store               | `.\node_modules\.bin\vitest.cmd run --config apps\desktop\vitest.config.ts --configLoader runner apps\desktop\src\infrastructure\novel-skill-evaluation-sqlite-store.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 1 file / 9 tests；3.58 秒      | PASS |
| Data / AI Core / Desktop TypeScript  | `.\node_modules\.bin\tsc.cmd -p packages\data\tsconfig.json --noEmit --pretty false`；`.\node_modules\.bin\tsc.cmd -p packages\ai-core\tsconfig.json --pretty false`；`.\node_modules\.bin\tsc.cmd --noEmit -p apps\desktop\tsconfig.json --pretty false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 三项退出码 0                   | PASS |
| Tauri 本地迁移链                     | `cargo test --manifest-path apps\desktop\src-tauri\Cargo.toml local_migrations --lib --no-fail-fast`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 8 passed / 150 filtered        | PASS |

三组 Desktop 文件互不重叠，合计 23 files / 250 tests。命令使用允许读取工作区 pnpm junction
目标的本地 shell；只有既有 Vite `esbuild`/`oxc` 弃用警告，没有测试失败。Data `0061` 仅作为
content-free ledger infrastructure 经实现者与独立审查批准；它不证明真实 Provider 输出、A/B
唯一变量、商业授权、人工评分可信来源或 Skill 增益。Data `0063` / Tauri `66`、评测 Runner、完整
`release:check`、真实 Tauri/DeepSeek、付费 A/B 和默认启用仍不在本节证明范围内。

### `0061` 收口过程失败记录（保留，不计为最终通过）

- 一次 root 复跑错误地给 AI Core 指向不存在的 `packages/ai-core/vitest.config.ts`，Vitest 在配置加载阶段退出，测试没有启动；改用上表包内命令后 17/17 通过。这是命令错误，不是代码测试失败。
- Desktop Store 首轮为 8/9；唯一失败是安全错误文案已改为“成功、完成、可见且未截断”，旧测试仍匹配原正则。修正断言后同一文件 9/9 通过，没有放宽生产门禁。
- 扩展恢复攻击组首轮为 19/22；三项失败均来自攻击夹具先触发基础 CHECK/trigger 或未释放备份句柄，尚未进入目标 semantic audit。夹具改成外键与基础约束合法、必由语义审计拒绝，并以 `finally` 释放资源后，2 files / 22 tests 通过。
- 更早的一项恢复负例期望 `DATABASE_RESTORE_FAILED`，实际准确返回 `DATABASE_RESTORE_BACKUP_INCOMPATIBLE`；断言改为真实错误分类后复跑通过。定向 PASS 不删除上述过程记录，也不替代完整工程门禁。

## 2026-08-10 v0.2.1 发布基线验证（历史，不覆盖当前增量）

| 范围                   | 精确命令                                                                                                                       | 结果                   | 状态 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ---- |
| Import/Export 全量测试 | `pnpm.cmd --filter @inkshadow/import-export test`                                                                              | 81/81 passed，0 failed | PASS |
| Settings 页面定向测试  | `pnpm.cmd --filter @inkshadow/desktop test src/pages/settings-page.test.tsx`                                                   | 34/34 passed，0 failed | PASS |
| Desktop TypeScript     | `pnpm.cmd --filter @inkshadow/desktop typecheck`                                                                               | 0 error                | PASS |
| Settings 聚焦 ESLint   | `pnpm.cmd exec eslint apps/desktop/src/pages/settings-page.tsx apps/desktop/src/pages/settings-page.test.tsx --max-warnings 0` | 0 error / 0 warning    | PASS |

这些聚焦结果只证明 DOCX 导入回归、设置页交互、Desktop 类型和设置页静态规则在当时执行快照中
通过；当时最终门禁另由下表和后续精确命令记录。它们不是当前 `0060`–`0062` 增量的最终证据。

| 当时门禁                             | 状态    | 说明                                                                                               |
| ------------------------------------ | ------- | -------------------------------------------------------------------------------------------------- |
| 最终 `pnpm.cmd release:check`        | PASS    | 退出码 0，520.9 秒；构建、格式、秘密、许可证、边界、发布配置、类型、Lint 与 workspace tests 全通过 |
| 最终 production build 与 bundle 预算 | PASS    | Desktop 2,204 modules；49 files / 6,065,923 bytes，预算 6,422,528 bytes，余量 356,605 bytes        |
| `pnpm.cmd check:rust`                | PASS    | 退出码 0，116.7 秒；format、严格 Clippy、152 passed / 1 ignored / 0 failed                         |
| 1440/1280/1024/800 与 200% zoom E2E  | PASS    | 指定 production `dist` 的 Chromium 规格 11/11；测试 23.1 秒、工具 29.4 秒；不等于 Tauri WebView    |
| 真实 DeepSeek Key 端到端             | NOT_RUN | 未读取或使用用户 Key，本地/模拟协议证据不能标记供应商 `VERIFIED`                                   |
| 干净 `v0.2.1` 候选与 SHA-256         | NOT_RUN | 候选未生成；来源提交、源指纹、文件大小和哈希均不得伪造                                             |

### 当时最终完整工程门禁

```powershell
pnpm.cmd release:check
```

当时结果：退出码 0，wall time 520.9 秒。

- 工作区执行报告为 20/21 workspace scopes；build、Prettier format check、秘密扫描、137 项运行时依赖许可证、20 项包边界、17 项 Desktop release source/config、全部 TypeScript、全仓零警告 ESLint 均通过；
- workspace tests：400 个测试文件通过、16 个文件按外部条件跳过；2,688 passed、65 skipped、0 failed；Cloud API 占 64 项外部 PostgreSQL 跳过；
- Desktop：212 个测试文件，1,520 passed、1 skipped、0 failed；唯一跳过继续是显式外部条件，不计为通过；
- Desktop production build：2,204 modules；有效载荷 49 files / 6,065,923 bytes，预算 6,422,528 bytes，余量 356,605 bytes，比要求保留的 50 KiB 最低余量再多 305,405 bytes；
- runtime chunk：474,119 / 512,000 bytes；PDF Worker：1,187,649 / 1,572,864 bytes；
- `release:check` 不包含 Rust、production E2E、Tauri/NSIS 或干净提交来源证明；这些证据必须分开记录。

### Rust 严格门禁

```powershell
pnpm.cmd check:rust
```

当时结果：退出码 0，wall time 116.7 秒；`cargo fmt --check`、全 target 严格 Clippy
`-D warnings` 通过，Rust tests 为 152 passed、1 ignored、0 failed。ignored 项保持显式，
不计为通过。

### Production Chromium 响应式 E2E

```powershell
node scripts/run-e2e.mjs --dist apps/desktop/dist tests/e2e/desktop-production-reflow.spec.ts tests/e2e/desktop-responsive.spec.ts tests/e2e/desktop-start.spec.ts tests/e2e/desktop-local-first.spec.ts --reporter=line
```

当时结果：11/11 passed；Playwright 测试耗时 23.1 秒，工具总耗时 29.4 秒。该组使用当时最终工作树的
production `dist`，覆盖 1440、1280、1024、800 和 200% zoom 的导航、抽屉、编辑器、Story
Settings 与 Model Hub 主路径。它运行在 Chromium，不是打包后的 Tauri WebView，不能替代候选
安装、启动或 WebView 验收。

### 2026-08-10 前次完整门禁失败（保留，不计为通过）

`pnpm.cmd release:check` 的前一次完整运行退出码为 1，wall time 701 秒。该次 build、format、
secrets、137 项 licenses、20 项 boundaries、17 项 Desktop release source/config、全部 typecheck
和 lint 已通过；Desktop 测试为 1,518 passed、1 skipped、2 timed out。两项超时均来自
`settings-page.test.tsx`，当时日志定位在第 493 与 535 行。

修复只优化测试交互成本：长字符串字段使用等价的 change 事件，并保留这两项跨异步 UI 集成测试
既有的 15 秒聚焦时限；没有改变生产保存/校验合同，也没有提高 Vitest 全局或局部 timeout。Settings 定向复跑
34/34 通过后，仍从头执行上述完整 `release:check`，最终 Desktop 1,520 passed / 1 skipped、
workspace 2,688 passed / 65 skipped / 0 failed。该最终 PASS 不删除这次失败记录。

### 2026-08-10 PR #1 首次远端 CI 失败（保留，不计为通过）

GitHub Actions run `31326891335` 在提交
`e3cfd72f6f346aac82ff7329859746ed8653651c` 上执行。Cloud PostgreSQL/forced RLS 与
Windows native shell 均通过；Windows 作业包含 Rust 检查、production 前端演练、未签名
NSIS 打包和附件上传。质量作业的 build、typecheck 与 lint 通过，唯一失败位于
`project-materials-page.test.tsx`：211 个 Desktop 测试文件通过、1 个失败，1,519 passed、
1 skipped、1 failed。

失败发生在点击“确认引用”以后。旧断言使用 Testing Library 默认 1 秒等待引用说明重新出现；
远端高负载下，持久化与页面重新加载尚未完成，失败快照中的对话框仍处于提交状态。修复仅让
该断言最多等待 5 秒，并在对应素材卡片内核对引用文本；没有修改生产素材或引用逻辑，也没有
提高 Vitest 全局或整项测试时限。

修复后的聚焦回归连续执行三次：

```powershell
pnpm.cmd --filter @inkshadow/desktop test src/pages/project-materials-page.test.tsx
```

每次均为 1 file / 2 tests passed、0 failed；三次测试耗时分别为 6.39、6.26 与 6.57 秒。
该文件的 ESLint、Prettier 与 `git diff --check` 同时通过。上述聚焦结果不替代修复提交的新一轮
完整 GitHub Actions；run `31326891335` 始终保留为失败证据。

## 2026-08-09 DeepSeek P0 历史工作树验证

### 全量门禁

- `pnpm.cmd release:check`：`PASS`，475.7 秒；生产构建、Prettier format check、秘密扫描、
  151 项许可证、20 包边界、Desktop release gate `17/17`、全部工作区 TypeScript、全仓
  ESLint 与 workspace tests 通过；
- Desktop：207 files，1,440 passed，1 skipped，0 failed；
- Data：62 files，357 passed，0 failed；
- Cloud API：87 passed，64 skipped，0 failed；跳过项需要外部 PostgreSQL 条件，不能计为通过；
- Web：33 passed，0 failed；
- `pnpm.cmd check:rust`：`PASS`；`cargo fmt --check` 和
  `cargo clippy --all-targets -- -D warnings` 通过；完整 Rust lib 152 passed，1 ignored，0 failed。

### 定向门禁

DeepSeek P0 Desktop 回归：

```powershell
.\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts --configLoader runner apps/desktop/src/infrastructure/model-hub-text-capability-probe.test.ts apps/desktop/src/infrastructure/quick-model-connection-service.test.ts apps/desktop/src/infrastructure/model-hub-local-evaluation-service.test.ts apps/desktop/src/infrastructure/model-hub-execution-service.test.ts apps/desktop/src/infrastructure/model-hub-router.test.ts apps/desktop/src/infrastructure/model-hub-routing-service.test.ts apps/desktop/src/infrastructure/native-model-dispatch-scope-contract.test.ts apps/desktop/src/infrastructure/ui-error.test.ts apps/desktop/src/pages/settings-page.test.tsx
```

结果：9 files，104 passed，0 failed。

Desktop TypeScript：

```powershell
.\node_modules\.bin\tsc.cmd --noEmit -p apps/desktop/tsconfig.json --pretty false
```

结果：0 error，`PASS`。

Data 迁移与维护：

```powershell
pnpm.cmd --filter @inkshadow/data exec vitest run tests/model-hub-migration.test.ts tests/maintenance.test.ts --config vitest.config.ts
```

结果：2 files，14 passed，0 failed。

原生模型网关：

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml model_gateway --no-fail-fast
```

结果：63 passed，1 ignored，0 failed。

Tauri 本地迁移链：

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml local_migrations --lib
```

结果：5 passed，0 failed。

### 未运行边界

- 真实 DeepSeek Key 在线端到端：`NOT_RUN`。未读取用户 API Key；模型目录、真实 SSE、账号额度、
  16 类初始文本分工和两项基础评测未在线串联验收；
- 截至本段历史工程门禁记录，安装包候选尚未生成；`release:check` 不等于打包。若随后从干净提交
  生成候选，必须以候选清单另行记录来源提交、SHA-256 和大小；当时尚未发布新的 GitHub Release。
  `v0.2.5` 的后续最终事实以本文顶部 source-bound 结果为准。

当前 Provider Registry 为 9 类，发布脚本门禁为 17 项。本轮结果只能证明本地实现与受控协议路径，
不能把 DeepSeek 供应商标记为 `VERIFIED`。根因、迁移、隐私和回滚边界见
[`2026-08-09-DEEPSEEK-TEXT-PROBE-P0.md`](2026-08-09-DEEPSEEK-TEXT-PROBE-P0.md)。

## 2026-08-09 既有 v0.2.0 发布基线（历史，不含本轮 P0）

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
不能迁移为该产物的通过证据；该产物本身也不能迁移为后来 v0.2.0 历史源码的候选证据。

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

## v0.2.0 历史发布结论

v0.2.0 的该次完整自动化、production E2E、NSIS 打包、提交绑定、版本、二进制摘要、远端 CI
和公开附件回读复核均已完成。它已发布为明确标注未签名与边界的 GitHub Pre-release 工程预览；
隔离 Windows 安装矩阵、真实供应商、商业签名、法律审批和独立安全审计未完成，因此不可标记为
Beta、GA 或商业正式版。这些历史结果不能替代本文首节所列 `v0.2.2` 当前门禁。

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

## 2026-08-09 生成前检查与 Model Hub 表单增量证据

本节只记录当前增量，不替代历史全仓、真实供应商或安装包验收。

| 检查                      | 精确命令                                                                                                                                              | 当前结果               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| AI Core 类型              | `pnpm.cmd --filter @inkshadow/ai-core typecheck`                                                                                                      | PASS                   |
| AI Core 生成前检查回归    | `pnpm.cmd --filter @inkshadow/ai-core test`                                                                                                           | `12 files / 73 passed` |
| Model Hub 表单最小条件    | `vitest run apps/desktop/src/infrastructure/model-hub-form-readiness.test.ts`                                                                         | `1 file / 4 passed`    |
| 未知价格浏览器治理账本    | `vitest run --environment jsdom generation-governance-store.test.ts -t "keeps an unpriced generation runnable without fabricating a monetary amount"` | `1 passed / 7 skipped` |
| 未知价格运行时预检        | `vitest run --environment jsdom generation-runtime.test.ts -t "warns without price metadata"`                                                         | `1 passed / 7 skipped` |
| 脱敏生成前诊断            | `vitest run --environment jsdom diagnostics.test.ts -t "exports bounded runtime health"`                                                              | `1 passed`             |
| SQLite 未知价格迁移与账本 | `vitest run generation-governance-sqlite.test.ts -t "persists pricing-unavailable runs and provider token usage without a fake amount"`               | `1 passed / 1 skipped` |
| Desktop 类型              | `pnpm.cmd --filter @inkshadow/desktop typecheck`                                                                                                      | PASS                   |
| Part B 定向 ESLint        | `eslint settings-page* preflight* model-hub-form-readiness* generation-preflight-diagnostics.ts --max-warnings 0`                                     | PASS                   |
| Settings 组件定向复跑     | `pnpm.cmd --filter @inkshadow/desktop test src/pages/settings-page.test.tsx`                                                                          | `1 file / 33 passed`   |

代码覆盖 `READY / READY_WITH_WARNINGS / BLOCKED`、单一保守上下文回退、未知价格的非零价冒充防护、
安全诊断字段，以及保存/发现/验证按钮对已保存凭据和新 Key 的最小条件。真实供应商返回、实际账单、
模型真实上下文窗口、原生迁移升级及打包后恢复仍需在干净依赖树和目标 Windows 环境继续验证。

## 2026-08-29：批量设定恢复进入可备份 SQLite

未完成的批量设定此前只由界面 localStorage 保存，正式 SQLite 备份无法覆盖；项目切换和坏记录保护主要依靠组件内状态。当前新增向前迁移 `0082_author_recovery_records.sql`／Tauri `85`，生产 runtime 显式注入 SQLite store，创建、更新、删除均使用修订号比较交换。浏览器开发使用等价持久适配器，但正式桌面端没有 localStorage 回退。坏或未来 schema 原始 JSON 不删除、不覆盖；作者必须明确放弃整批内容，输入变化不再隐式清除恢复记录。

| 范围                        | 当前精确命令                                                                                                                    |     通过 | 失败 | 跳过 | 说明                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------: | ---: | ---: | -------------------------------------------------------- |
| Store 与 0081→0082 连续升级 | `pnpm --filter @inkshadow/data test -- author-recovery-sqlite-store.test.ts released-v023-continuous-upgrade.test.ts`           |        3 |    0 |    0 | 原始 JSON、CAS、并发写、项目隔离、全新库和连续升级       |
| VACUUM 备份恢复             | `pnpm --filter @inkshadow/data test -- maintenance.test.ts -t "restores all supported tables from a healthy backup atomically"` |        1 |    0 |   50 | 恢复后 payload、revision、时间戳逐字一致                 |
| 批量恢复与本地解析          | `pnpm --filter @inkshadow/desktop test -- story-governance-page.test.tsx story-settings-authoring.test.ts`                      |       58 |    0 |    0 | A→B 隔离、异常重启去重、坏记录保留、逐条审阅和零模型调用 |
| 数据与桌面类型              | `pnpm --filter @inkshadow/data typecheck`；`pnpm --filter @inkshadow/desktop typecheck`                                         | 2 个命令 |    0 |    0 | 当前工作树聚焦类型检查                                   |
