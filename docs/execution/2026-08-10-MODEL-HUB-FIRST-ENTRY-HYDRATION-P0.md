# Model Hub 首次进入状态失真 P0 证据与修复记录

日期：2026-08-10  
范围：只处理 Model Hub 首次进入、连接切换和目录刷新时的状态一致性；不记录 API Key、请求 Header、提示词或作品正文。

## 2026-08-13 真实诊断复核与代码收口

v0.2.2 诊断 `8b48a2a6-7f94-42fa-ae57-1bb02a6c7234` 证明最新一次 Model Hub
bootstrap 在真实 Tauri 中于 `03:45:19.964` 开始、`03:45:20.040` 完成，只耗时 `76 ms`；
最终快照为 `READY`，系统凭据为 `configured`，1 个连接可用、目录有 2 项、16 条任务路由启用，
数据库与索引均健康。因此不能把诊断中的 `03:37:49.792 → 03:45:20.040` 直接解释成一次
hydration 花了 7 分 30 秒，也不能把任务中心的 `TASK_RETRY_EXHAUSTED` 归因于本次加载。

这份旧版本诊断也暴露出原 P0 记录尚不能直接关闭：

1. `hydrationStartedAt` 实际记录第一次 UI snapshot 的时间，不是 bootstrap 真正开始时间；
2. `ModelHubOperationCoordinator` 每次页面 mount 都从 generation 0 开始，首个 operation ID 都会成为
   `model-hub:bootstrap:1`；诊断状态却跨 mount 保留，返回页面后的同名 action 会覆盖首次 action 及其错误；
3. 当前诊断把第一次 snapshot 的开始时间与最新一次 snapshot 的完成时间拼接，无法区分页面重挂载、
   renderer/系统挂起或真实阶段等待；
4. Keyring 读取没有有界 watchdog；真实 Windows Credential Manager 冷启动仍未完成故障注入验收。

当前工作树已修复前三项，并为凭据摘要增加有界降级：

1. 每个 `ModelHubOperationCoordinator` 分配唯一 `coordinatorId`，operation ID 现在包含
   coordinator、action 和 generation；跨 mount 同名 action 不再互相覆盖；
2. 诊断分别记录 `pageMountedAt`、`phaseStartedAt` 与 bootstrap 真正开始时才写入的
   `hydrationStartedAt`，`completedAt` 只由 bootstrap 终态完成；生产 effect 的真实调用顺序也有回归测试；
3. 系统凭据摘要等待上限为 5 秒；超时返回 `MODEL_HUB_CREDENTIAL_STATUS_TIMEOUT`，页面进入
   `READY_WITH_WARNINGS`，保留缓存目录，迟到的凭据结果不能再写回；
4. 显式请求、已保存路由和默认回退均会排除 disabled/retired 连接；停用连接仍可在完整列表中查看，
   但不会被选中或触发凭据读取。

因此本文件的当前结论为：**`CODE_FIXED / REAL_TAURI_NOT_VERIFIED`。** 聚焦自动化、Desktop 全量、
类型检查和 production build 已通过；但当前工作树尚未在打包后的 Windows Tauri 中复核 SQLite +
Keyring 冷启动、离开/返回、最小化、睡眠恢复和真实超时故障注入。旧的 2026-08-10 与 v0.2.2 诊断
继续作为历史问题和部分真实证据，不作为当前代码已在真实 Tauri 通过的证明。

## 附件证据索引

| 证据                                | 时间                       | 可核对事实                                                                                                | 结论                             |
| ----------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 诊断 `5968312d-602a-4772-93e9-97d…` | `2026-08-10T03:15:19.966Z` | 数据库健康；Model Hub 有 1 个连接、1 个可用连接、2 个目录模型、15 条启用任务路由，`coreWritingReady=true` | 后端并非“未配置”                 |
| 诊断 `89bcb1aa-23c4-4c62-be21-a30…` | `2026-08-10T03:18:01.899Z` | 与上一份后端计数一致                                                                                      | 问题不是三分钟内配置消失         |
| 首次进入截图                        | 用户本轮附件图 1           | 页面短暂显示“没有发现可用模型”“系统凭据库未配置”                                                          | UI 把初始空 state 当成了权威结果 |
| 恢复后截图                          | 用户本轮附件图 2           | 同一连接恢复为 DeepSeek、2 个模型、凭据末四位                                                             | 延迟读取完成后后端状态能被恢复   |

两份诊断中的旧 `MODEL_OUTPUT_TRUNCATED` / `TASK_RETRY_EXHAUSTED` 来自 2026-08-09 的开书引导和能力探针，不能作为 2026-08-10 首次进入失败的当前会话证据。

## 根因

旧页面以 `connections=[]`、`models=[]`、`credential.configured=false` 初始化，然后依次执行兼容迁移、连接读取、目录读取、路由读取，最后才读取系统凭据。React 在链路完成前已经渲染这些初始值，因此出现了假“未配置”和假“没有模型”。此外还存在三项放大问题：

1. 连接快速切换时，较慢的旧请求没有 generation/target 校验，可以覆盖较新的选择。
2. 目录重新检查失败会执行 `setModels([])`，清空仍然有效的本地缓存目录。
3. 保存连接、保存/删除凭据、发现模型和能力验证后分别手工更新部分 state，提交成功但刷新失败时会误报为整个操作失败。

## 当前实现契约

页面现在使用一个权威 hydration 快照，阶段为：

`UNINITIALIZED → BOOTSTRAPPING → LOADING_CONNECTIONS → RESTORING_SELECTION → CHECKING_CREDENTIAL → LOADING_CATALOG → READY / READY_WITH_WARNINGS / ERROR`

- 加载完成前只显示“正在读取/恢复/检查”，不显示终态“未配置”或“没有发现模型”。
- 多连接冷启动时，显式 URL 选择优先；否则恢复正文生成路由所引用目录项的连接；最后才回退到第一条连接。
- 没有已保存连接时保持“未配置”；只有明确使用 `authenticationMode=none` 的已保存连接才标记为 `not_required`。
- Ollama 或认证方式为 `none` 的连接标记为 `not_required`，不访问系统凭据库，也不显示“缺少密钥”。
- 每次选择或变更都有 operation generation；旧 generation 的迟到结果记录为 `stale_ignored`，不能写回 UI。
- 每个 coordinator 还有独立身份；跨页面 mount 的相同 action/generation 也不能覆盖彼此。
- 凭据摘要读取最多等待 5 秒；超时只把当前快照降级为 `READY_WITH_WARNINGS`，保留缓存目录和可重试入口。
- 保存和发现类操作先完成后端提交，再原子刷新快照。若后端已提交而刷新失败，明确提示“已保存，需要重新载入”，不要求用户重复输入密钥。
- 目录刷新失败时保留缓存模型，并显示 `cached_warning` 和重试入口。
- StrictMode 下兼容迁移使用同一 in-flight Promise；失败清理不会产生无人处理的派生 rejected Promise。

## 安全诊断字段

脱敏诊断 schema v3 新增：

- `modelHubUiSnapshot`：hydration 阶段、连接/目录 UI 数量、选中连接和模型、快照修订号；
- `recentModelHubActions`：操作、结果、是否已提交、是否刷新、是否忽略过期结果、错误码、HTTP 状态和目录数量；
- `pageMountedAt`、`phaseStartedAt`、`hydrationStartedAt`：区分页面挂载、阶段切换和 bootstrap 真正开始；
- `currentSessionStartedAt`、`currentSessionErrorCodes`、`historicalErrorCodes`。

当前会话错误同时合并 UI action 和会话开始时刻之后的 AI failure；早于开始时刻的错误归入历史。同一错误码去重，时间边界按“等于开始时刻属于当前会话”处理。

诊断结构没有 API Key、Authorization Header、完整请求/响应、提示词或作品内容字段。

## 2026-08-10 运行证据（历史）

- `pnpm --filter @inkshadow/desktop test src/infrastructure/model-hub-page-hydration.test.ts src/infrastructure/model-hub-ui-diagnostics.test.ts src/infrastructure/diagnostics.test.ts`
  - 结果：3 个测试文件、13 项测试全部通过。
- `pnpm --filter @inkshadow/desktop test src/pages/settings-page.test.tsx`
  - 结果：1 个测试文件、36 项测试全部通过。
- `pnpm --filter @inkshadow/desktop typecheck`
  - 专项接线完成后的首次结果：退出码 `0`，Desktop TypeScript 全量类型检查通过。
  - 最终复跑时并行开发已继续修改 structured-capability-probe 与 editor 文件，命令被这些专项外错误阻断；本专项的 hydration、Settings 与 diagnostics 文件没有类型错误。发布前须在并行开发收口后重跑，不能用首次通过替代最终门禁。

上述命令属于当时快照。2026-08-13 当前工作树的精确聚焦测试、Desktop 全量、类型检查和 production
build 结果见 [`TEST_RESULTS.md`](TEST_RESULTS.md)；它们仍不替代打包 Tauri 的真实冷启动验收。
