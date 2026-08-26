# Phase 1：导入作品分析合同与当前停用边界

> 代码复核：2026-08-20 当前工作树  
> 文档状态：`SUPPORTING_CURRENT`  
> 当前结论：安全导入、本地章节读取和历史 Candidate 决定链可用；新的 Provider 分析/试改/逐章生成入口失败关闭

## 1. 用户链路

`/create/import` 继续提供安全导入、本地章节读取、改写目标和已经保存的隔离 Candidate 决定链。
旧入口不能在发送前完整锁定并展示精确模型、总调用上限、总费用与隐私去向，因此当前
`providerGenerationAvailable=false`：新的 Provider 分析、代表段落试改、逐章生成和重新生成均不
派发。作者仍可跳过分析继续本地流程，也可查看、显式接受/拒绝或恢复已有 Candidate。

下列两类可恢复任务属于仍保留的服务合同，不是当前 UI 可新建的 Provider 能力：

1. 人物、关系与叙事：人物身份/状态、核心或普通关系、POV、写作风格；
2. 世界、事件与剧情：章节摘要、世界设定/规则、时间线、事件、物品/能力变化、伏笔和章节结束
   时的剧情状态。

历史任务仍按章节版本、段落分块和 UTF-16 绝对位置恢复；页面不在旅程草稿中复制正文。停用不会
删除旧分析、待确认 StoryFact、Candidate 或决定审计，也不会把它们自动提升为当前证据。

## 2. 结构化输出门禁

保留实现文件：`apps/desktop/src/infrastructure/import-work-analysis-service.ts`。当前页面不会调用它
创建新的 Provider 工作；若未来重新启用，必须先接入统一精确披露/确认并继续满足以下门禁：

- 只使用 Model Hub 的 `character_extraction` 与 `world_extraction` 任务路由；
- 路由目标必须有未过期的 `text_generation` 和 `structured_output` 能力证据；不根据模型名称猜测；
- 调用前后核对 connection、catalog entry、model 和 fallback 选择，选择漂移时不派发；
- 返回值必须是单个 JSON 对象，不接受 Markdown 围栏或对象外文字；
- 根对象、来源对象、事实对象和证据对象都执行精确字段校验，拒绝缺失字段和额外字段；
- 章节 ID、版本 ID、分块序号、分块起点和长度必须与请求完全一致；
- 每条事实必须引用当前分块中的连续原文，`startOffset`、`endOffset` 和 `excerpt` 必须逐字符匹配；
- 事实类型按分析阶段使用白名单，文本长度、集合大小、置信度和控制字符都有边界；
- 重复事实、来源漂移或中断恢复时内容漂移都会停止该项，不覆盖已保存结果。

原生网关尚未提供供应商侧 `response_format/json_schema` 参数；即使未来恢复入口，也只能把
“Model Hub 结构化能力证据 + 客户端严格协议解析”作为客户端门禁，不能冒充供应商原生 JSON
Schema 强制输出。当前停用状态下调用上限为 0。

## 3. 统一 StoryFact 写入

历史上通过校验的结果仍写在现有 `runtime.story.factService.stageAutomaticFact`，没有第二套故事状态表：

- `origin = ai_extraction`；
- `status = unconfirmed`；
- `needsReview = true`；
- `userConfirmed = false`、`locked = false`；
- `source.kind = chapter_span`，保存章节、当前版本、UTF-16 起止位置、原文长度和精确摘录；
- source reference 由版本、分析阶段、分块和结果序号组成，同一中断任务重试时可幂等复用；
- 人物身份、核心关系、世界规则、死亡、重大时间线/能力/物品和伏笔状态不会自动成为正式事实；
- 页面链接到“故事设定”，用户可以查看原文依据后确认、锁定或废弃。

事件统一写为 `factType = causal_event`，结构版本为
`inkshadow.causal-event-fact.v1`。导入分析不会从人物姓名伪造正式人物 ID；未识别地点使用显式
`unresolved-location / 未标注地点`，等待用户确认或后续实体绑定。当前步骤不直接写因果图。

## 4. 恢复与失败行为

- 历史“章节 × 分析类别”状态继续留在本机旅程记录中；刷新只恢复查看，不恢复派发权限；
- 运行中被关闭的旧任务恢复为 `IMPORT_ANALYSIS_INTERRUPTED`，不会自动重复调用或重复计费；
- 页面可以展示上次可能已派发的请求、供应商和模型，但当前不会提供新的 Provider 重试；
- 路由未配置、结构化能力未验证、上下文/费用/隐私门禁失败、JSON 无效、证据不匹配或本地写入失败
  都保留导入原文；
- 失败项可以跳过；新的 Provider 重试、代表段落试改和逐章建议生成保持关闭；
- 跳过或停用不会删除已经保存的待确认事实和隔离 Candidate，也不会阻塞其显式决定。

## 5. 当前边界

- 当前导入页精确产生 0 次新的 Provider 调用；配置模型不重新开启旧入口；
- 关闭旧入口不会绕过 Candidate：历史建议仍须作者显式接受，并经正文 fence 创建新不可变版本；
- 未来重新启用任何分析/试改/逐章动作前，必须显示连接显示名、精确模型、发送/不发送范围、
  local/remote 隐私、调用上限、0 自动重试、费用上限或 unknown，并在确认前及 Provider 边界前
  复核 inspection/pricing/privacy/source/version fingerprint；
- 本阶段提取证据化候选事实，不自动合并同名人物，也不把人物姓名当作正式实体 ID；
- 不跨章节推断隐藏关系或未明说的因果；跨章节归并与实体绑定仍需后续统一状态处理；
- `causal_event` 只有用户确认后才允许进入权威因果投影；
- 用户在“故事设定”确认结构合格的因果事实后，可以显式刷新“故事关联”；导入流程本身不会
  自动重建因果图，也不会生成 `causal_relation`；
- 确认后的其他结构化事实可以被续写上下文和检查读取，但只有满足各自 schema、角色和
  coverage 门禁时才会生效；“已确认”不等于所有检查器都会盲目接收；
- 模型返回空 findings 是合法结果，页面会如实显示 0 条，不用规则猜测补齐；
- 扫描 PDF 的 OCR 仍不在本链路内，必须先获得可提取文本。

## 6. 当前验证

- 保留服务仍有结构协议、精确证据、未确认生命周期、事件格式、能力门禁、无效 JSON、原文保护和
  幂等恢复测试；它们不把当前停用入口升级为可用 Provider 动作；
- 当前导入页聚焦回归为 1 file / 5 tests PASS：新的 Provider 入口关闭，已保存 whole-chapter
  `replace_document` Candidate 仍需显式接受，接受阶段 0 Provider，并创建新不可变版本；
- 首次有效运行 4 pass / 1 fail 是测试 fixture 错用 continuation intent，被产品策略安全拒绝；只修正
  fixture 后 5/5 PASS。冻结发布候选的完整 Desktop 为 265 files / 2,049 passed / 1 skipped /
  0 failed；真实 Provider 仍为 `BLOCKED_EXTERNAL`。
