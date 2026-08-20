# DeepSeek 写作能力验证失败 P0 排障记录

> 日期：2026-08-09  
> 应用版本：`0.2.0`  
> 范围：仅修复文本能力探针、能力证据、初始任务分工、基础评测前置条件和脱敏诊断链路  
> 验收状态：代码与本地协议路径已修复；尚未使用用户的真实 DeepSeek API Key 完成线上端到端验收

## 1. 现象与影响

已保存的 DeepSeek 连接能够读取模型目录，但“验证写作能力”返回
`MODEL_OUTPUT_TRUNCATED`。由于失败探针不能提交 `text_generation = supported` 的能力证据，
智能分工在 22 类小说任务中找不到合格候选，界面显示配置 0 类任务；本地基础评测随后也因没有
已持久化的任务路由而停止，而不是因为评测文本本身失败。

用户导出的 schema v1 诊断中的 `modelProfileCount = 0` 来自旧版 `modelCenter` 档案兼容层。
它不统计 Model Hub 连接、模型目录、能力证据或任务路由，因此不能据此判断 DeepSeek 连接是否
已经保存。截图中的“模型目录连接成功”和这个旧指标可以同时成立。schema v2 将旧指标明确
重命名为 `legacyModelProfileCount` / `legacyModelProfilesWithSelection`，并新增
`modelHubConnectionCount`、`modelHubUsableConnectionCount`、`modelHubCatalogEntryCount` 和
`modelHubEnabledTaskRouteCount`，避免再把两套存储含义混在一起。

## 2. 实际根因链

故障发生在“能力探针请求预算 + DeepSeek 推理模式 + 原生响应归一化”的组合边界，不在 API Key
保存、模型目录发现、Embedding 或基础评测算法中：

1. 设置页和快捷连接路径使用固定短指令“只回复：OK”，但只给生成请求 `8` 个输出 token；
2. DeepSeek V4 Flash/Pro 的思考模式默认开启。DeepSeek 的 `max_tokens` 同时覆盖推理和最终回答，
   推理内容与可见正文分别位于 `reasoning_content` 和 `content`；
3. 这个极小预算可能先被推理消耗，服务以 `finish_reason = "length"` 结束；
4. 原生 OpenAI-compatible SSE 解析器当时只读取可见 `content`，并在处理同一帧可见增量前先把
   `length` 映射成 `MODEL_OUTPUT_TRUNCATED`；
5. 上层因此无法证明模型产生了非空可见文本，能力扫描失败，不提交文本生成证据；
6. 路由器按能力证据过滤模型，得到 0/22；基础评测只执行已保存的任务路由，所以继续报
   `MODEL_HUB_ROUTE_NOT_CONFIGURED`。

DeepSeek 对思考模式和返回字段的当前合同见
[Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion) 与
[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)。修复按供应商能力策略执行，
没有把某个具体模型名称永久写死为路由依据。

## 3. 历史响应证据边界

旧版诊断只保存了归一化错误码，没有持久化供应商响应包、SSE 帧、可见输出长度或推理长度。
因此不能声称已经从这次历史调用恢复出具体 `reasoning_content`、其 token/字节长度，或当时是否
已经出现可见 `content`。结合官方协议和错误分支，可以把供应商响应的**可能结构**脱敏表示为：

```text
HTTP 2xx
content-type: text/event-stream

data: {
  "id": "<redacted>",
  "choices": [{
    "delta": {
      "reasoning_content": "<redacted-or-absent>",
      "content": "<redacted-or-empty>"
    },
    "finish_reason": null
  }]
}

data: {
  "choices": [{
    "delta": { "content": "<redacted-or-empty>" },
    "finish_reason": "length"
  }]
}

data: [DONE]
```

这不是历史原包，也不证明两类增量都实际出现；它只说明与当前 DeepSeek SSE 合同和
`MODEL_OUTPUT_TRUNCATED` 分支相容的字段关系。以后诊断只保存有界、脱敏的结构化元数据，仍不
保存这些原始帧。

## 4. 修复后的合同

### 4.1 一个共享文本能力探针

- 设置页“验证写作能力”、快捷连接的手动/已配置连接检查，以及本地基础评测共用同一探针策略；
- 固定探针仍不包含作品正文，输出预算统一为 `64` token；
- Provider Registry 仅对 `DeepSeek` 探针声明 `reasoningMode = disabled`，原生 OpenAI-compatible
  请求把它映射为 `thinking: { "type": "disabled" }`；其他供应商不会收到 DeepSeek 专有策略；
- 生产正文生成、续写、改写和 Candidate 生成不使用这个探针例外，截断时仍严格失败，绝不把
  不完整内容当成完整正文。

### 4.2 截断与可见文本

原生解析器会先处理同一响应帧中的可见 `content` 和 usage，再处理终止原因；
`reasoning_content` 只转成“是否出现/有界长度”诊断，不作为正文增量发送到页面。

能力探针是窄范围例外：如果原生层报告 `MODEL_OUTPUT_TRUNCATED`，但此前已经得到非空可见文本，
探针可以以 `partial` 保存失败元数据，同时提交“能够输出可见文本”的能力证据。如果只有推理、
没有可见文本，或响应完全为空，探针仍失败。这个规则不适用于任何用户正文或 AI 建议版本。

### 4.3 能力证据、初始分工与评测

- 非空探针成功后才提交 `text_generation = supported`；失败扫描不能伪造支持证据；
- 第一次成功验证且当前完全没有任何任务路由记录时，智能推荐可为 `16` 类仅依赖文本生成的核心
  小说任务建立可执行分工；旧版若在第 16 项失败并留下纯自动、同方案的 15/22 中断计划，会原子、
  幂等补齐；任一用户路由（包括已禁用路由）都不会被覆盖；
- `preset + 完整 novel_task_routes` 由一次事务提交；写入失败时完整旧方案保持不变。价格、上下文
  长度与基础评测结果只参与可选排序，不再被误当成文本分工的提交门槛；
- 总任务目录仍有 `22` 类。结构化输出、Embedding、Rerank、图片、视觉等任务继续等待各自能力
  证据，不能由文本探针冒充；
- 本地基础评测仍是路由后的两条固定短测试，只检查指令/结构遵循和延迟。它不是能力发现器，
  也不是文笔、剧情、一致性或真实性评分。

## 5. 脱敏诊断与迁移

诊断 artifact 升级为 schema v2，并从现有能力扫描和调用事实账本读取最近失败：

- `requestId`、归一化错误码、阶段、是否可重试；
- HTTP 状态、`finishReason`、可见内容长度；
- 是否出现推理、是否实际使用流式响应、尝试次数和请求的最大输出 token；
- 供应商、模型、任务、状态和发生时间等既有账本元数据。

配置摘要同时分别报告旧兼容档案数量和 Model Hub 的连接总数、可用连接数、目录条目数、启用任务
路由数。这里的“可用连接”仅表示连接已启用且状态为 ready/degraded，不替代当前请求的能力证据。

`recentLogs` 仍明确为空；诊断不保存 Prompt、章节正文、模型可见回答、推理内容、供应商原始错误
正文、API Key 或上传文件。`errorCodes` 与 `requestIds` 会纳入这些最近 AI 失败，便于关联。

Data 迁移 `0056_model_hub_failure_diagnostics.sql` 只向现有 `model_capability_scans` 和
`model_invocation_facts` 追加可空、受约束的诊断列和失败查询索引；Tauri 连续迁移号为 `59`。
历史行保持 `NULL`，不会根据旧错误反推不存在的推理长度或可见内容。浏览器开发存储 schema 从
5 前向升级为 6，并为旧记录补 `null`，不删除连接、目录、证据或路由。

本报告完成后，共享树的迁移头继续只向前推进到 Data `0059` / Tauri `62`：`0057`/Tauri `60`
补齐 Model Hub 的 `content_quality_check` 任务合同，`0058`/Tauri `61` 保存 Story Settings 原子导入
收据，`0059`/Tauri `62` 区分生成费用可估与价格未知。后两项不改写 `0056`、探针协议、能力证据
判定或 16 类文本分工，因此不改变本 P0 的根因和结论；这里只记录当前迁移头，不把后续产品增量
算成本专项的验证证据。

## 6. 兼容性、安全和回滚

### 旧连接与配置

- 已保存的 DeepSeek 连接、模型选择和 OS 凭据槽无需重新创建；
- 已有任一用户启用、禁用或自定义路由均保持原样；首次探针自动分工只处理“完全没有路由记录”或
  “纯自动、同方案且未完成”的恢复情况；
- 旧能力/调用记录继续可读，新诊断字段为 `NULL`；
- 缺少 Embedding 路由只影响语义记忆相关能力，不再阻断文本能力验证和核心文本任务分工。

### 其他供应商

所有供应商的无内容文本探针都获得相同 `64` token 预算；只有 DeepSeek Provider Registry 策略
禁用探针思考。OpenAI、百炼/Qwen、豆包、Gemini、Claude、GLM、Ollama 和自定义兼容连接的
普通生成参数没有被改成 DeepSeek 参数。供应商目录成功仍不等于文本生成可用，必须得到真实可见
文本证据。

### 回滚

数据库迁移是只向前的，不能删除 `0056` 列、倒改已发布 `0031`，或改写其校验和。Data `0057` /
Tauri `60` 通过重建 `model_evaluation_results`、`novel_task_routes` 与 `model_invocation_facts`，为三张
表补入 `content_quality_check`，并保留既有行、0056 失败诊断列、索引、隐私触发器、自引用 fallback
和外部 invocation link。若新探针策略需要回滚，应在新的应用构建中撤回探针行为但保留 `0056`/
Tauri `59` 与 `0057`/Tauri `60`；当前迁移头另含 `0058`/Tauri `61` 和 `0059`/Tauri `62`，同样
不能倒改或删除。回滚前先创建本地备份，不要让已迁移数据库直接降级到不认识迁移 62 的旧二进制。
诊断列和任务枚举迁移不参与正文、Candidate、版本或 StoryFact 权威写入。

## 7. 本轮本地验证证据

这些结果绑定当前工作树，只证明本地代码、协议、迁移和受控测试链路；`release:check` 是发布前
工程门禁，不等于已经构建安装包、创建发布提交或发布 GitHub Release。

### 全量门禁

- `pnpm.cmd release:check`：`PASS`，475.7 秒；生产构建、格式检查、秘密扫描、151 项许可证、
  20 包边界、Desktop release gate `17/17`、全部工作区 TypeScript、ESLint 和 workspace tests
  通过；
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

结果：9 files，114 passed，0 failed；其中设置页 33/33，通过 15→16 纯自动中断恢复、能力探针成功但
路由事务失败时保留成功证据和旧分工、最终 enabled 数量展示，以及 legacy 兼容投影失败不回滚核心
分工。

Desktop TypeScript：

```powershell
.\node_modules\.bin\tsc.cmd --noEmit -p apps/desktop/tsconfig.json --pretty false
```

结果：`PASS`，0 error。

Data 迁移与维护：

```powershell
pnpm.cmd --filter @inkshadow/data exec vitest run tests/model-hub-migration.test.ts tests/maintenance.test.ts --config vitest.config.ts
```

结果：2 files，16 passed，0 failed。

路由原子化与 `content_quality_check` 漂移修复的当前补充回归：

```powershell
.\node_modules\.bin\vitest.cmd run apps/desktop/src/infrastructure/model-hub-routing-service.test.ts apps/desktop/src/infrastructure/model-hub-store.test.ts apps/desktop/src/infrastructure/ui-error.test.ts --config apps/desktop/vitest.config.ts
```

结果：3 files，40 passed，0 failed。覆盖浏览器存储失败不改变内存/持久状态、SQLite 中途失败整批回滚、
纯文本能力生成 16 条核心路由、`content_quality_check`、重开持久化、用户路由保留、可选费用/评测
投影缺失，以及 legacy 投影失败不回滚权威 Model Hub 方案。

```powershell
cd packages/data
..\..\node_modules\.bin\vitest.cmd run --config vitest.config.ts --configLoader runner tests/model-hub-migration.test.ts
```

结果：1 file，7 passed，0 failed。22 类任务逐项写入三张受影响表，未知任务仍拒绝；0056 升级夹具
保留路由、评测、调用、失败诊断、自引用 fallback、外部 invocation link、索引和隐私触发器，且
`foreign_key_check` 为空、`integrity_check` 为 `ok`。

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

当前 Provider Registry 为 9 类供应商；发布脚本门禁为 17 项。这里的数字来自本轮实际命令，不能
与较早候选的 8 类供应商或旧版发布测试数量混用。上述 `release:check` 本身不生成安装包；若随后
从干净提交生成候选，其 SHA-256、大小和来源提交需另行记录。截至本历史执行快照，尚未发布新的
GitHub Release；后续 `v0.2.5` 的最终发布事实以 `RELEASE_CHECKLIST.md` 为准。

## 8. 尚未完成的真实验收

本次没有读取或使用用户的真实 DeepSeek API Key，因此不能声称 DeepSeek 线上账号、模型额度、
区域网络和当前供应商服务已经端到端通过。发布前仍应在目标 Windows 安装包中完成一次：模型目录
发现 → 64-token 写作能力探针 → 文本能力证据 → 16 类初始文本分工 → 两项基础评测，并导出 schema
v2 脱敏诊断确认链路。验收不得把 API Key、Prompt、模型回答或推理内容写入报告。
