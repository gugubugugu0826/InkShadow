# Model Hub 首次进入状态失真 P0 证据与修复记录

日期：2026-08-10  
范围：只处理 Model Hub 首次进入、连接切换和目录刷新时的状态一致性；不记录 API Key、请求 Header、提示词或作品正文。

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
- 保存和发现类操作先完成后端提交，再原子刷新快照。若后端已提交而刷新失败，明确提示“已保存，需要重新载入”，不要求用户重复输入密钥。
- 目录刷新失败时保留缓存模型，并显示 `cached_warning` 和重试入口。
- StrictMode 下兼容迁移使用同一 in-flight Promise；失败清理不会产生无人处理的派生 rejected Promise。

## 安全诊断字段

脱敏诊断 schema v3 新增：

- `modelHubUiSnapshot`：hydration 阶段、连接/目录 UI 数量、选中连接和模型、快照修订号；
- `recentModelHubActions`：操作、结果、是否已提交、是否刷新、是否忽略过期结果、错误码、HTTP 状态和目录数量；
- `currentSessionStartedAt`、`currentSessionErrorCodes`、`historicalErrorCodes`。

当前会话错误同时合并 UI action 和会话开始时刻之后的 AI failure；早于开始时刻的错误归入历史。同一错误码去重，时间边界按“等于开始时刻属于当前会话”处理。

诊断结构没有 API Key、Authorization Header、完整请求/响应、提示词或作品内容字段。

## 当前运行证据

- `pnpm --filter @inkshadow/desktop test src/infrastructure/model-hub-page-hydration.test.ts src/infrastructure/model-hub-ui-diagnostics.test.ts src/infrastructure/diagnostics.test.ts`
  - 结果：3 个测试文件、13 项测试全部通过。
- `pnpm --filter @inkshadow/desktop test src/pages/settings-page.test.tsx`
  - 结果：1 个测试文件、36 项测试全部通过。
- `pnpm --filter @inkshadow/desktop typecheck`
  - 专项接线完成后的首次结果：退出码 `0`，Desktop TypeScript 全量类型检查通过。
  - 最终复跑时并行开发已继续修改 structured-capability-probe 与 editor 文件，命令被这些专项外错误阻断；本专项的 hydration、Settings 与 diagnostics 文件没有类型错误。发布前须在并行开发收口后重跑，不能用首次通过替代最终门禁。

发布前仍需以干净提交重新执行完整 Settings 页面回归、桌面端 typecheck、build 和打包证据，不以本记录替代发布门禁。
