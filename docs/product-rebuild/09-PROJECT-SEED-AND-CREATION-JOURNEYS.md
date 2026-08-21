# ProjectSeed 与三条创建旅程（当前实现）

> 文档状态：`SUPPORTING_CURRENT`  
> 当前应用清单：`0.2.6`；最新已发布版本：`v0.2.5` 工程预览；设计基线：`DESIGN v0.3.1b`

更新日期：2026-08-21

## 当前结论

三条创建入口共享 `@inkshadow/domain` 中同一个 `ProjectSeed` 领域契约。它是创建输入，不是正式正文，也不会自动晋升为 StoryFact。每个字段保存值、来源、确认状态、来源位置和更新时间，因此“空白”“用户跳过”“AI 推测”和“用户确认”不会被混为一谈。

已发布 `v0.2.3` 仍是固定 5 问加关键词扩展，未读取已选开头和 ProjectSeed 的真实缺口；这是历史
实现，不是当前已发布 `v0.2.5` 的源码事实。当前实现先持久化三个隔离开头槽，并等待作者明确选择一个可用
方案；随后只运行一次确定性缺口规划，根据原始想法、已选开头、ProjectSeed 和可证明文本一次生成
最多 3 个核心问题，信息充分时允许 0–2 个。结构化问题记录目的、目标字段、提问原因和来源；作者
可以返回、跳过或直接结束创建。回答只更新既定问题与 ProjectSeed，不追加新问题，不自动重写开头，
也不触发第 4 次 AI planner 调用；只有作者明确选择时才执行一次基于全部回答的整合重写。

当前修复统一作者自然语言为 NFC，在创建批次和 Provider 调用前返回具体输入原因，并让每个失败槽
进入终态；0 个可用方案不显示问题卡，1 个可用方案也不能自动冒充作者选择。合法开头生成批次的
预期调用数精确为 3；选择开头、生成确定性 0–3 问计划和回答问题均为 0 次 Provider 调用。

`v0.2.6` 未发布工作树进一步修复批次提前结束：三个稳定槽现在各自等待并结算，首个本地持久化
失败不会丢弃其他槽的成功结果，也不会让已发送槽悬挂。明确失败单独归档；越过发送边界却无法
确认结果的槽显示“结果待核对”；重启只读取并结清原槽，不创建第二次发送。最终 Windows Tauri
三槽混合结果与真实模型账本对账仍为待验证。

项目创建前，旅程或页面恢复快照仍负责恢复未完成输入；真实项目一旦存在，ProjectSeed 会同时写入按 `project_id` 查询的独立本地数据层：

- 原生桌面端：SQLite `project_seeds`；
- 浏览器开发模式：`inkshadow.development.project-seeds.v1` 本地持久化 store；
- 一句话开书：创建项目后、创建章节和 Candidate 前写入；
- 导入改写：项目已经存在，目标或规则变化后持续写入；
- 专业创建：项目建立后、补齐规划和设定前写入。

`project_seeds` 由 `0039_project_seeds.sql` 创建，并在 SQLx 本地迁移中登记为 version 42。表以项目为主键，保留 seed id、旅程类型、契约版本、完整 JSON、存储修订号和时间；项目删除时级联删除。

## 已进入真实续写上下文

ProjectSeed 已不再只是创建页和持久化底座。当前真实续写链路会按章节的 `projectId` 读取 `runtime.projectSeeds.findByProjectId(...)`，通过 `selectProjectSeedContextCandidates(...)` 转成带层级和证据的 `ContextCandidate`，再作为 `creationSeedCandidates` 交给统一 Context Compiler。

这条链路同时用于：

1. `prepareGenerationPlan(...)` 的非演示续写计划；
2. `createConfiguredModelCandidate(...)` 的直接配置模型续写。

编译器会把 ProjectSeed 与当前任务、正式 StoryFact、当前章节、因果链、写作偏好、语义检索和 Rerank 补充统一排序，在当前续写路径的 `7,000` Token 上下文预算内记录采用或舍弃。真正发给模型的提示只包含 `included: true` 的条目；执行前会保存上下文 Trace，Trace 保留候选 id、层级、采用原因、Token 估算、预算前后、采用/舍弃状态和证据定位，但不会复制候选正文或 evidence excerpt。

ProjectSeed 仍不是正式故事事实：进入生成上下文只代表“作者确认过的创建输入可供本次创作遵守”，不代表它被自动提升为权威 StoryFact。

## 字段到上下文层的映射

| ProjectSeed 字段   | 用户含义       | Context Layer             | 当前优先级与约束                |
| ------------------ | -------------- | ------------------------- | ------------------------------- |
| `premise`          | 创作起点       | `world_setting`           | 700                             |
| `genre`            | 小说类型       | `current_task`            | 700                             |
| `tone`             | 故事基调       | `current_task`            | 700                             |
| `characters`       | 人物           | `character_current_state` | 700                             |
| `relationships`    | 人物关系       | `character_current_state` | 700                             |
| `world`            | 世界背景       | `world_setting`           | 700                             |
| `conflict`         | 核心冲突       | `scene_goal`              | 700                             |
| `style`            | 写作风格       | `current_task`            | 700                             |
| `pov`              | 叙事视角       | `current_task`            | 700                             |
| `boundaries`       | 作者明确禁止项 | `locked_hard_rules`       | 1,000；编译后为 required 硬约束 |
| `currentDirection` | 当前剧情方向   | `scene_goal`              | 900                             |
| `initialOutline`   | 初步大纲       | `scene_goal`              | 700                             |
| `rewriteRules`     | 改写规则       | `current_task`            | 700                             |

每个入选字段会以 `[用户已确认的字段名]` 加逐项列表的形式进入候选内容。`boundaries` 高于其他 ProjectSeed 字段，`currentDirection` 次之；最终仍由统一层级顺序、required 规则和 Token 预算共同决定编译结果。

## 确认门槛与证据来源

适配器逐字段执行以下门槛：

- 只有 `confirmation === "confirmed"` 且 `values` 非空的字段才创建上下文候选；
- `unconfirmed` 一律不进入续写提示，即使它来自 AI 分析或已有值；
- `skipped` 一律不进入；
- AI 推测或导入分析只有在作者确认后才可能进入，不能因 `source` 看起来可信而绕过确认；
- 没有 ProjectSeed 时返回空候选，不伪造默认设定。

每个候选当前记录：

- 候选 id：`project-seed:{projectId}:{fieldKey}:r{revision}`；
- `sourceId`：项目 id；
- `sourceVersionId`：`seed-r{revision}`；
- `locator`：`project-seed:{fieldKey}`；
- `selectionReason`：说明该字段已由作者确认；禁止项使用单独的硬约束说明；
- `sourceType`：`imported_text` / `import_analysis` 映射为 `import`，其他已确认创建输入映射为 `user_input`。

原始 `field.source`、`origin`、`confirmation` 和 `updatedAt` 仍完整保存在 ProjectSeed 中。当前 Context Trace 使用的是较粗粒度的证据引用，尚未把 `origin`、字段更新时间、内容哈希和原文 excerpt 一并投影到 Trace；这仍是后续可追溯性增强项。

## 旧数据升级

迁移会从 `creative_journeys.snapshot_json.projectSeed` 中选择每个项目最新的有效旧记录回填。缺字段或损坏的 JSON 不会进入强类型数据层，原始恢复快照仍保留。

浏览器本地 store 会读取旧的一句话旅程、导入恢复草案和专业创建恢复记录，并按项目选择最新有效 ProjectSeed。Tauri 启动时也会尽力把 WebView 本地恢复记录补入 SQLite；指向已删除项目的旧指针会被隔离，不会阻止本地工作区启动。

异步旧写入不能覆盖更新时间更新的 ProjectSeed。SQLite 与浏览器 store 都按 `updatedAt` 拒绝倒退写入。作者自然语言使用 NFC 规范化：组合等价字符会规范合成，但中文全角标点、引号和作者刻意使用的全角字形不会被兼容折叠。

## 数据安全与备份

ProjectSeed 不包含导入原文，导入原文仍只存在章节和不可变版本系统中。AI 生成文本仍必须进入 Candidate；ProjectSeed 不会绕过接受、拒绝、Diff、版本和撤销边界。

`project_seeds` 已加入 SQLite 备份恢复白名单、删除顺序和插入顺序。恢复合同会在备份后篡改
ProjectSeed，再确认恢复得到原 payload 和 revision；截至 Data `0070` / Tauri `73`（70 Data + 3
story-core），当前共有 173 张应用表，恢复权威白名单为 172 张表。写作偏好、披露 grant、调查
run/step/finding/evidence 与 step 的 planned invocation 列随同恢复；1 张短期远程派发租约表不恢复，
4 个可重建派生根表在同一恢复事务中清空。

## 2026-08-08 ProjectSeed 历史定向测试证据

本次 ProjectSeed → 真实续写上下文链路的聚焦运行：

```text
..\..\node_modules\.bin\vitest.CMD run src\infrastructure\project-seed-context-adapter.test.ts src\infrastructure\generation-runtime.test.ts --config vitest.config.ts --configLoader runner
工作目录：仓库内 `apps/desktop`
Test Files  2 passed (2)
Tests       9 passed (9)
```

其中：

- `project-seed-context-adapter.test.ts` 验证 confirmed 字段的层级、优先级和证据引用，并验证未确认的 `ai_inference` 人物不会进入候选；
- `generation-runtime.test.ts` 验证真实续写计划的编译条目包含 `boundaries`、标记为 `locked_hard_rules / included / required`，最终提示包含已确认禁止项，同时不包含未确认的世界推测；
- `packages/domain/tests/project-seed.test.ts` 覆盖作者中文标点、引号、全角字形和 NFC 组合字符保真；
- `packages/data/tests/project-seed-sqlite-store.test.ts` 覆盖 SQLite 往返、项目隔离、修订递增、旧异步写入不覆盖新值和项目删除级联；
- 创建旅程、迁移、浏览器 store 和备份恢复的公开测试边界见
  `docs/execution/TEST_RESULTS.md`；本节数字只对应 2026-08-08 当时的聚焦运行。

## 尚未宣称完成

本增量没有把完整 ProjectSeed 产品闭环标记为 VERIFIED，仍缺少：

1. 真实打包 Tauri 进程退出、重启后的端到端恢复；
2. 导入分析产生的带证据、未确认事实回填人物、关系、世界、POV 和风格字段；
3. 除续写以外的改写、润色、开书引导、检查和规划任务统一消费 ProjectSeed；
4. ProjectSeed 读取失败目前会降级为空候选以保证正文仍可继续，但尚未给用户可见诊断，也没有在 Trace 中记录“ProjectSeed 来源不可用”；
5. Context Trace 尚未携带 ProjectSeed 的原始 `origin`、字段更新时间、内容哈希和证据 excerpt；
6. 完整创建到 Candidate 接受、正式事实提取和派生索引重建的 E2E；
7. ProjectSeed 的云同步策略；当前实现是本地项目数据与本地备份覆盖，不宣称跨设备同步。

因此，当前可以准确描述为“ProjectSeed 已进入真实续写上下文，并只消费作者确认字段”，但不能据此把完整创建旅程、所有 AI 任务或后续故事智能阶段标记为 VERIFIED。
