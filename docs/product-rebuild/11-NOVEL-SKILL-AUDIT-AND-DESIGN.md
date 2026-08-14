# Novel Skill 现状审计、最小合同与启用门禁

> 审计日期：2026-08-10  
> 状态：`SUPPORTING_CURRENT / EXPERIMENTAL_OPT_IN`  
> 结论适用范围：当前工作树中的小说写作方法层；不替代 Model Hub、StoryFact、Context Compiler、Candidate 或写作偏好  
> 重要限制：桌面端运行时与 UI 已接线，但只允许作者按项目显式启用；所有内置 Skill 均为 `EXPERIMENTAL`、`defaultEnabled=false`，真实 A/B 状态仍为 `NOT_EVALUATED`

## 1. 结论先行

审计前的 InkShadow **没有等价的内置小说 Skill 体系**。它已经具备可靠的事实、上下文、偏好、任务路由和 Candidate 安全底座，也有多处针对具体任务的硬编码 Prompt，但缺少同时具备以下条件的写作方法层：

- 版本化 Definition；
- 项目级启用、关闭和版本固定；
- 按任务、创作模式、题材与上下文激活；
- 有界 Prompt 开销与冲突裁决；
- 每次调用使用了哪些版本的可重放快照；
- 在默认启用前进行跨模型 A/B 评测。

因此，本轮先实现了四张 SQLite 表、严格 TypeScript 合同、编译器、七个原创 Core Skill 定义、五个原创 Genre Skill 定义、调用前快照门缝和原创中文 A/B fixture；随后把它们接入桌面生成运行时与可见 UI。接线不改变启用结论：**没有作者显式选择时，第一次开书和续写都不会加载任何 Novel Skill**；只有作者在项目“写作方法（实验）”中明确启用后，对应任务才会编译方法片段并写入精确调用快照。

当前运行现状是：

- 一句话开书仍由 `creative-opening-service.ts` 的任务合同驱动，并在真实派发前准备和提交作者已显式启用的精确 Skill 快照；
- 正文续写仍复用任务合同、十二层 Context Compiler 和 Model Hub 路由；作者显式启用且适用于本任务的 Skill 作为独立有界方法段加入同一调用链；
- 选区改写、导入改写、规划、摘要和检查各自使用其任务专用 Prompt；
- `NovelSkillRuntime.prepareInvocation(...)` 调用 `compileNovelSkills(...)`，并在 `context_trace_id → generation_id → model_invocation_id` 链存在后、派发前提交 content-free invocation snapshot；
- “写作方法（实验）”允许按项目显式开关；“本次参考”能按实际调用显示方法名称、版本、采用/舍弃原因和独立估算预算，缺少回执时不会冒充已使用；
- 手动写作、自动保存、版本、Candidate、导出和恢复完全不依赖 Novel Skill。

这项保守边界是刻意的：没有真实 A/B 证据时，只能提供明确告警的实验性作者选择，不能为了满足“默认启用”而把未经验证的方法注入普通用户生成。

## 2. 相近系统审计

| 现有系统             | 当前真实能力                                                                                | 为什么不等于 Novel Skill                                                                           | 复用决定                                                      |
| -------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| WritingPreference    | 保存手动或反馈模式形成的可见偏好；最多 24 条启用项作为 `current_task` 候选进入上下文        | 是“这个作者偏好怎么写”，不是经过版本化评测的通用创作方法；无适用任务、输出合同、Skill 版本或冲突组 | 保留为高优先级用户输入，不复制到 Skill 表                     |
| ProjectSeed          | 保存题材、基调、人物、POV、边界、方向和改写规则等创建输入；只有作者确认字段可进入真实上下文 | 是“这个项目准备写什么”，不是“采用哪套方法写”                                                       | 未来只用于 Skill 推荐/激活输入，不成为 Skill 内容             |
| StoryFact / 因果图   | 维护故事中什么是真的、证据、权威状态、人物知识和因果关系                                    | 是事实真相源，不是写作方法                                                                         | Skill 只声明所需层，不写入或修改 StoryFact                    |
| Context Compiler     | 十二层选择、预算、来源、采用/舍弃原因和精确调用链                                           | 已解决“AI 这次读取什么”，未解决“AI 采用什么写作方法”                                               | Skill 使用独立小预算，最终必须由同一 Context/dispatch 链承载  |
| Model Hub 22 类任务  | 供应商能力、模型目录、任务主备路由、费用与隐私                                              | 回答“哪个模型执行哪个任务”，不回答“任务用什么小说方法”                                             | Skill task key 直接复用同一 22 项枚举，不建第二套任务表       |
| Prompt Registry      | 有七类 Prompt 的校验、激活和渲染内核及单测                                                  | 当前桌面生产生成链未发现统一消费者；也没有项目绑定、Skill 激活、调用快照或 A/B                     | 不作为第二运行时；未来可由同一 Prompt Policy 统一承载渲染结果 |
| 风格模板 / Style Lab | Marketplace 合同中存在 `style_template` 类型；历史文档有风格实验室概念                      | 当前没有证据表明它作为统一方法层进入生产生成；不是版本化 Core/Genre Skill                          | 不把 Marketplace 扩大为 Skill Marketplace；只保留未来映射可能 |
| 社区/团队模板        | 可保存项目设置、Prompt 引用和规则等协作元数据                                               | 模板是可复用配置包，不是逐调用激活与评测的方法                                                     | 不复用为运行时 Skill，不建立平行模板入口                      |
| 多 Agent / 检查器    | 有证据化检查、StoryFact/因果读取和任务级 Prompt                                             | 多 Agent 角色、检查规则与 Novel Skill 的粒度和费用模型不同                                         | Skill 不自动开启 Agent；确定性检查仍优先                      |

### 2.1 对审计问题的直接回答

1. **第一次一句话开书加载了哪些方法？** 默认不加载 Novel Skill；若作者已在该项目明确启用实验方法，开书派发会加载当前任务适用的固定版本并保存精确 snapshot。
2. **第一次正文生成加载了哪些方法？** 续写始终使用任务合同、十二层上下文、正式事实、有效摘要、因果、偏好和可用检索；只在作者显式 opt-in 时额外加载当前任务适用的版本化 Skill。
3. **不同任务是否共享同一通用 Prompt？** 否。开书、续写、选区改写、导入改写、规划、摘要、提取和检查分散在多个服务中。
4. **是否有场景目标/阻力/转折/状态变化方法？** 有。`core.scene_craft` 提供版本化、可关闭的实验方法，但默认关闭且尚无真实 A/B 结论。
5. **对话、声纹、POV、节奏、因果是否存在？** StoryFact、上下文层、验证器和规划/检查继续作为事实/证据系统；Novel Skill Registry 另提供对应方法定义，不替代这些权威来源。
6. **是否有默认 Genre Skill？** 没有。当前五个 Genre 定义均为 `EXPERIMENTAL` 且 `defaultEnabled=false`。
7. **题材是否自动激活不同写作方法？** 不会。ProjectSeed 现在只能产生带字段、原值、确认状态和匹配信号的可解释建议；投影明确禁止自动 binding，必须由作者后续确认。
8. **是否有 Skill 版本？** 审计前没有；本轮基础层新增 immutable `skill_id + version`。
9. **是否记录每次用了哪些 Skill？** 是。开书与续写在同一 trace/generation/invocation 链上保存 content-free snapshot 和逐项采用/舍弃记录；无回执不冒充使用。
10. **是否能关闭/覆盖某个 Skill？** 是。项目“写作方法（实验）”界面通过显式 binding 开关控制；关闭只影响后续调用，不删除历史快照。
11. **冲突如何裁决？** 审计前没有；新编译器按显式选择优先、排他组和 rule id 处理。两个显式选择冲突时 fail closed。
12. **是否有 A/B 证明更好？** 没有；当前状态明确是 `NOT_EVALUATED`。
13. **写作偏好是不是成熟方法？** 不是；它是作者可见、可编辑的个人规则。
14. **风格模板是否进入生成链？** 当前未找到可信的统一生产接线证据。
15. **是否过度依赖反馈学习？** 反馈学习能改善个人偏好，但不能提供开箱即用的方法；因此需要单独 Skill 层。
16. **普通用户能否看懂当前使用什么？** 能查看本次实际采用/舍弃的方法、名称、版本、原因和预算；内部 ID/hash 不是普通摘要的主要文案。实验状态和关闭入口保持可见。

## 3. 外部一手资料研究

研究只读取候选仓库固定 commit 的代码、`SKILL.md`、许可证与测试目录；没有安装其 runtime，没有复制第三方 Skill 文本、模板或小说内容。下面的许可证判断只针对所列 commit。

| 候选                                                                                                                                          | 固定 commit / 许可证                                                                                                   | 可借鉴的抽象                                                  | 决定                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| [Story Skills](https://github.com/danjdewhurst/story-skills/tree/c482d48f4eb9b488f033a77a51f9fae55cc0d75f)                                    | `c482d48…` / [MIT](https://github.com/danjdewhurst/story-skills/blob/c482d48f4eb9b488f033a77a51f9fae55cc0d75f/LICENSE) | setup/payoff、知识/物品状态、精确证据、确定性 continuity 测试 | 只借鉴证据化与确定性优先；不复制 Markdown bible/CLI            |
| [Better Writing](https://github.com/forjd/better-writing/tree/4023076319e5a7838dd7587ebf3d5e3588f9544f)                                       | `4023076…` / MIT                                                                                                       | voice calibration、具体性、终稿检查、eval 结构                | 转化为原创 `Prose Specificity` 目标；不复制禁词或 Skill 文本   |
| [Creative Writing Skills](https://github.com/haowjy/creative-writing-skills/tree/fd7a3ad9cd7697a0645ff6ff4bd5e809cf7673a3)                    | `fd7a3ad…` / Apache-2.0                                                                                                | brainstorm/write/critique/revise/explore 模式分离与上层路由   | 采用六种调用模式合同；不引入其文件/运行时                      |
| [book-os](https://github.com/forsonny/book-os/tree/bf155998505bd5951e73564c3ff1b5fbe7190e83)                                                  | `bf15599…` / MIT                                                                                                       | Standards / Novel / Manuscripts 分层                          | 映射为安全规则 / 项目事实与偏好 / 当前任务；不复制文件系统     |
| [agent-skills / story-coach](https://github.com/jwynia/agent-skills/tree/e02ec7e226a6e4f8419fd3b88a1d8e472d421b32)                            | `e02ec7e…` / 根目录许可证未确认；Skill 元数据声明 MIT                                                                  | Coach 与代写分离                                              | 仅概念参考；许可证未完整确认，因此不复制内容                   |
| [Writers Room Story Engine](https://github.com/jackterror/writers-room-story-engine/tree/f146ab0a7778e545d95d3c95afdae6fb29a55823)            | `f146ab0…` / MIT                                                                                                       | 分阶段路由、场景功能、因果链；仓库含手工测试提示              | 采用通用场景/因果目标；不把单一西方结构设为硬规则              |
| [Graphify Novel](https://github.com/Anshler/graphify-novel/tree/124c9abc473508e081a625e4d2a24b24071581a2)                                     | `124c9ab…` / MIT                                                                                                       | Bible 是事实、Graph 是关系投影                                | 与既有 StoryFact/因果图一致；拒绝安装 graphify 依赖或第二图谱  |
| [Bookwright](https://github.com/jmorenobl/bookwright/tree/51d5a7bf78de6556352035f4a00e3019bd45874f)                                           | `51d5a7b…` / [EUPL-1.2](https://github.com/jmorenobl/bookwright/blob/51d5a7bf78de6556352035f4a00e3019bd45874f/LICENSE) | spec 驱动、provenance、`not-evaluated(reason)`、自动测试      | 只采用“证据不足不冒充通过”的思想；不复制实现                   |
| [Claude-Book](https://github.com/ThomasHoussin/Claude-Book/tree/3fdebbb576b1be6d123b48258d2310c5dff013c4)                                     | `3fdebbb…` / MIT                                                                                                       | planner/writer/reviewer/state updater 职责分离                | 不默认运行全套 Agent；只保留有界职责边界                       |
| [AuthorAgent](https://github.com/Ckokoski/AuthorAgent/tree/47e9570fb96b9d151a3b1f9c22e3a365eab9bd9c)                                          | `47e9570…` / MIT                                                                                                       | 分层记忆、角色 voice critic、用量可见；有 loader 测试         | 复用 InkShadow 既有上下文/用量系统，不引入另一内存层           |
| [oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode/tree/70a834e88d1103f494f45667bab4b31472a83b58)                     | `70a834e…` / MIT                                                                                                       | 中文连载节奏、按需加载、章节追踪                              | 仅作为未来可选 Genre Pack 研究；不默认联网扫榜，不复制大 Skill |
| [howells/fiction](https://github.com/howells/fiction/tree/47f467b801df74477a7a98016b45b321d4a3eb5a)                                           | `47f467b…` / 根目录许可证文件未确认，README 声称 MIT                                                                   | 架构、人物、正文、审校模块边界                                | 仅概念参考，不复制内容                                         |
| [web-novel-writing-guidance-skill](https://github.com/HZ-KMNO/web-novel-writing-guidance-skill/tree/24dd6d40099c97c3120dc37942e8dc99263c0259) | `24dd6d4…` / MIT                                                                                                       | 中文网文工作流与分步指导                                      | 仅未来评测候选，不把网文方法泛化到所有小说                     |
| [avoid-ai-writing](https://github.com/conorbronsdon/avoid-ai-writing/tree/d9fbca05a912aae8b35b56c92d132962c2cf4520)                           | `d9fbca0…` / MIT                                                                                                       | 对泛化、空洞、重复的检查思路                                  | 非小说专用且易风格收敛；不采用固定禁词/AI 检测目标             |

选择性吸收的是“分层、模式、证据、渐进加载、可评测”这些抽象原则。七个 Core 定义及 12 个中文 fixture 均为 InkShadow 原创文本，不形成第三方衍生文件，也不需要新增第三方许可证清单。

## 4. 最小数据合同

Data migration `0060_novel_skill_registry.sql`（Tauri/SQLx migration 63）新增四张表：

迁移和备份清单保留在 `@inkshadow/data`；依赖 AI Core 合同的 SQLite 适配器位于桌面基础设施层 `apps/desktop/src/infrastructure/novel-skill-sqlite-store.ts`。数据层不反向依赖 AI Core，避免把产品编译策略下沉为通用存储依赖。

### 4.1 `novel_skill_definitions`

- 复合主键：`skill_id + version`；
- owner/kind 只允许 `builtin -> core|genre`、`user -> custom`；
- canonical 三段 semver，拒绝 `01.0.0`；
- immutable update trigger；
- 任务必须来自 Model Hub 同一 22 项集合且不得重复；
- `default_enabled=1` 只允许 `status='active'`；
- 保存 definition hash 与可选来源 URL/commit/license，不保存模型响应。

### 4.2 `project_novel_skill_bindings`

- 项目级固定 immutable definition 版本；
- `activation_mode = smart|manual`，不会永久锁死具体任务模式；
- 每个 22 类任务可覆盖 `enabled` 与 `invocationMode`；
- SQL 与 TypeScript 同时拒绝未知任务、未知字段、自由文本、敏感键和两个值同时为 null；
- revision 单调递增；仅 active project 可新增或更新绑定。

### 4.3 `novel_skill_invocation_snapshots`

- 只能在 exact `context_trace_id -> generation_id -> model_invocation_id` 链存在后写入；
- 保存任务、调用模式、compiler version、独立 Skill token 预算、选择 hash、候选/采用/舍弃计数；
- 保存有界、可重放 `configuration_snapshot_json`，而不是只存 hash；
- dispatch 前在同一事务内重新读取 immutable definition 与项目 binding revision，再运行编译器并深比较完整选择、规则、token、输出类型和渲染片段；调用方伪造或过期的编译结果不能落库；
- configuration 只能含固定 11 个字段和 portable identifiers；
- SQL/TypeScript 均禁止 credential、API key、Prompt、章节/正文、StoryFact 内容、模型 response、hidden reasoning、instruction/excerpt/body/content 等敏感或自由文本字段；
- append-only；链路不完整时 dispatch 回调不会执行。
- 读取时重新计算 configuration hash、完整渲染 token、候选/采用/舍弃计数和 item membership；即使绕过 immutable trigger 篡改一列，也会归一为 `NOVEL_SKILL_STORE_CORRUPT`。

### 4.4 `novel_skill_invocation_items`

- 每个被考虑的 definition 一条记录，包含版本、hash、激活来源、采用/舍弃原因、优先级与估算 token；
- definition hash 必须与 immutable definition 精确匹配；
- 激活来源、采用原因和舍弃原因运行时与 SQL 双重枚举校验；
- append-only。

四表已经加入本地备份/恢复的全表覆盖、删除顺序和恢复顺序。它们不存正文，也不会成为 StoryFact 或 Candidate 的平行权威源。

## 5. 编译与冲突边界

`compileNovelSkills(...)` 保持纯函数式核心 seam，并由桌面 `NovelSkillRuntime` 在开书与续写的真实派发前调用。只有项目显式绑定会把 `allowExperimental` 打开；浏览器开发模式明确返回不可用，不生成伪 snapshot。

输入复用同一 22 个任务、六种调用模式、十二个 Context Layer，并显式提供：

- 项目；
- 当前任务与模式；
- 题材标签；
- 用户显式选择；
- 当前可用上下文层；
- experimental opt-in；
- definition 与项目 binding；
- 独立 Skill token budget。

编译规则：

1. 未评测 `EXPERIMENTAL` 必须显式 `allowExperimental=true`；
2. required context 缺失时舍弃并记录原因；
3. 只加载本次命中的完整 rules，未命中的只留下 content-free invocation item；
4. Skill 预算按最终 `<novel_method>` 整段渲染后的 UTF-8 byte 数保守估算；标签、selection hash、规则来源和 validation 文本全部计入，整段不得超过保留预算；预算耗尽时舍弃低优先项，不占用 StoryFact/正文预算；
5. 用户显式选择先于自动选择和普通 precedence；
6. 两个用户显式选择在排他组或同一 rule id 上冲突时 fail closed，不静默替作者选择；
7. 非显式冲突才按 precedence 处理；同级仍无法裁决时 fail closed；
8. 编译结果渲染为独立 `<novel_method>` 片段，由当前开书/续写 orchestrator 在同一预算与 trace 链内发送；未选择、冲突或预算不足的项只留下 content-free 舍弃原因。

Skill 只回答“应该怎么写”。最终生产优先级必须仍是：安全/隐私与输出合同 > 用户锁定事实和世界硬规则 > POV/知识边界 > 用户显式任务与偏好 > 显式 Skill > Core/Genre Skill > 学习偏好 > 模型默认。当前纯编译器只裁决 Skill 内部冲突，不能绕过外层安全与事实合同。

## 6. 首批 Core 与 Genre 定义

### 6.1 七个 Core

| skill id                    | 目的                                                       | 当前状态       | 默认 |
| --------------------------- | ---------------------------------------------------------- | -------------- | ---- |
| `core.scene_craft`          | 场景目标、阻力、行动、变化与因果承接                       | `EXPERIMENTAL` | 关闭 |
| `core.character_dialogue`   | 意图、关系、反应、潜台词、语言区分和知识边界               | `EXPERIMENTAL` | 关闭 |
| `core.pov_knowledge`        | 当前 POV、可知/未知/误信与叙事距离                         | `EXPERIMENTAL` | 关闭 |
| `core.causality_continuity` | 时间、地点、物品、人物状态、setup/payoff 与 open questions | `EXPERIMENTAL` | 关闭 |
| `core.prose_specificity`    | 具体动作与名词、段落节奏、避免空泛且保留作者风格           | `EXPERIMENTAL` | 关闭 |
| `core.revision_discipline`  | 限定改写范围、保持事实/POV、Candidate/Diff 安全            | `EXPERIMENTAL` | 关闭 |
| `core.evidence_critique`    | 有证据的错误/风险/建议与 `NOT_EVALUATED`                   | `EXPERIMENTAL` | 关闭 |

### 6.2 五个 Genre

| skill id               | 目的                                           | 当前状态       | 默认 |
| ---------------------- | ---------------------------------------------- | -------------- | ---- |
| `genre.campus_romance` | 用共同日常、关系距离和双方选择推进校园青春恋爱 | `EXPERIMENTAL` | 关闭 |
| `genre.light_novel`    | 用清晰视角、交互节奏和段落落点保持轻快可读     | `EXPERIMENTAL` | 关闭 |
| `genre.mystery`        | 管理线索可见性、人物解释、误导边界和揭示后果   | `EXPERIMENTAL` | 关闭 |
| `genre.fantasy`        | 维护超常规则、能力限制、代价和世界反应         | `EXPERIMENTAL` | 关闭 |
| `genre.web_serial`     | 推进近期承诺、累积变化并留下非重复的后续动力   | `EXPERIMENTAL` | 关闭 |

纯 `novel-skill-activation.ts` 只把 ProjectSeed 的题材、故事想法、基调、风格和当前方向投影为建议。每项建议显示匹配字段、原值、来源、确认状态与匹配信号；即使来自已确认字段，也仍是 `recommendation_only`、`requiresAuthorConfirmation=true`、`automaticBindingAllowed=false`。建议本身不会写 binding、不会修改 definition 默认值；只有作者在 UI 中明确开关后，桌面 runtime 才持久化项目 binding。

这五个定义尚未完成真实 A/B，不能因为 ProjectSeed 命中标签就自动加载到 Prompt。当前仅允许作者明确启用的实验路径；默认上线仍需完成跨模型评测、人工评审与单独的启用决策。

## 7. A/B 设计与当前结果

评测器定义四个 arm：

1. `no_skill`；
2. `core`；
3. `core_genre`；
4. `core_genre_preferences`。

当前固定为 12 个 InkShadow 原创中文 fixture，覆盖校园恋爱第一人称续写、悬疑限知 POV、奇幻因果场景、网文动作具体性、家庭题材小范围改写、多线时间地点冲突及补充的检查/规划合同。运行数据库只保存 fixture ID、任务、模式、题材标签和合同哈希；原始 fixture 文本不会进入评测账本，也不包含商业小说文本。

评测合同固定为 13 个分别评分的维度，不使用单一“文学质量分”或 AI 检测器得分；其中安全、事实、POV、因果和改写范围等门禁按 blocking 处理。旧 8 项草案已被 schema、store 与 evaluator 拒绝。完整 run 必须形成 `192 cells × 13 = 2,496` 个人工评分槽，并记录 reviewer、rubric 版本与评分时间；任一要求项缺失都不能进入完成评审。

矩阵严格固定为 `12 fixture × 4 arm × 2 个互异模型槽 × 2 次重复 = 192 cells`；suite 只保存计划/fixture/Skill manifest/偏好配置的哈希元数据，每次 run 独立生成自己的 192 cells。模型槽是 portable identifier，真实 provider/model 以内容无关的身份哈希绑定到 run，不能硬编码某个供应商永远最好。评测按每个模型分别执行 `no_skill → core → core_genre → core_genre_preferences` 的逐阶 blocking 回归门，并保守阻断缺失成本证据、明显成本上涨和明显延迟上涨。即使所有量化门槛通过，也只返回 `ELIGIBLE_FOR_REVIEW`，不会自动改默认值。

评测证据必须为每个 cell 使用唯一 repetition，并为每条 observation 使用全局唯一 `modelInvocationId`；调用必须为 `succeeded`、已完成、存在非空可见输出且未因长度截断。每条证据还要精确连接同一 context trace、模型调用、Skill snapshot（`no_skill` 必须正反向都没有 snapshot）以及专用归档评测项目中的未接受隔离 Candidate；结果哈希和 Unicode 可见长度必须与 Candidate 一致。重复 cell/repetition、复用调用回执、事后改变 Skill membership 或任一 blocking 指标为 null 都直接拒绝。

`0061_novel_skill_evaluation_ledger.sql`（Tauri/SQLx migration 64）使用九张 append-only、content-free 评测表：suite、fixture、manifest item、run、cell、attempt、observation、score 和 manual decision。fixture 只在专用空白归档项目中运行；每个 cell 固定任务/题材适用性、目标与 considered manifest。非适用 arm 必须保存目标因 `task_mismatch` 或 `genre_mismatch` 被舍弃的精确记录。失败或取消也必须留下不含作品内容的 attempt，不能通过无痕重试隐藏成本；派发前先持久绑定 trace/invocation，跨重启可恢复。模型证据采集与 13 项人工评分分离，全部要求分数到齐才允许 cell 进入 observed；恢复事务还会重算 Candidate、trace、调用、Skill snapshot、完整采用/舍弃来源和证据摘要，不能只靠外键通过。

**本轮没有任何真实 Provider 评测观察值。当前精确结果：**

```text
status = NOT_EVALUATED
defaultEnablement = KEEP_DISABLED
observationCount = 0
```

因此七个 Core 都不得默认启用，也不能宣称“已提升写作质量”。

### 7.1 项目状态与 Candidate 原子围栏

`0062_project_dispatch_active_guard.sql`（Tauri/SQLx migration 65）只补上“持有既有项目派发 lease 时项目不得离开 active”的迁移门禁。同一变更集的 Rust/TS 代码把 `0045` 已有项目上下文原生生命周期租约扩展到回环本地请求，并加强 Candidate/context output 的原子权威复核。租约只允许在项目仍为 active、章节仍有效、当前版本与隐私指纹精确匹配时取得；原生请求 future 存活期间，项目不能转为非 active。

供应商返回后，Candidate 与上下文输出在同一 SQLite 事务内再次复核项目状态、章节状态、当前版本、Candidate 基线和 context source version。迟到完成结果、项目或版本失效及归档竞态都不能越过这道原子围栏。用户取消时，只允许把取消前已经可见的文本保存为 `incomplete` 隔离 Candidate，绝不修改正式正文。

## 8. 已执行聚焦证据（当前稳定点）

本轮 Desktop 集成回归使用下列根目录命令：

```powershell
.\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts --configLoader runner apps/desktop/src/infrastructure/model-hub-page-hydration.test.ts apps/desktop/src/infrastructure/model-hub-ui-diagnostics.test.ts apps/desktop/src/infrastructure/diagnostics.test.ts apps/desktop/src/pages/settings-page.test.tsx apps/desktop/src/infrastructure/generation-runtime.test.ts apps/desktop/src/infrastructure/model-hub-execution-service.test.ts apps/desktop/src/components/context-history-panel.test.tsx apps/desktop/src/pages/editor-workspace-simplification.test.tsx apps/desktop/src/pages/idea-journey-page.test.tsx apps/desktop/src/infrastructure/model-hub-creative-chain-integration.test.ts apps/desktop/src/infrastructure/novel-skill-runtime.test.ts apps/desktop/src/infrastructure/novel-skill-sqlite-store.test.ts apps/desktop/src/infrastructure/chapter-summary-service.test.ts apps/desktop/src/infrastructure/core-creative-loop.integration.test.ts
```

| 当前证据                                    | 结果                                 | 覆盖                                                                                              |
| ------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 上述 14 文件 Desktop 集成回归               | `14 files / 184 tests PASS`，47.8 秒 | hydration/schema v3、诊断、生成执行、上下文历史、开书/续写、Skill runtime/store、摘要与核心创作链 |
| Desktop TypeScript                          | `PASS`，exit code 0                  | 当前 Desktop 类型边界                                                                             |
| Provider fallback / recommendation 定向回归 | `2 files / 10 tests PASS`            | 官方资料 fallback、Provider 推荐与探针边界                                                        |
| Candidate 原子竞态定向回归                  | `2 files / 27 tests PASS`            | 项目状态、版本与 Candidate 提交围栏                                                               |
| 一句话开书定向回归                          | `2 files / 57 tests PASS`            | 首次开书、隔离 Candidate、精确 Skill/trace 链                                                     |
| maintenance                                 | `49/49 PASS`                         | 166 张可恢复表的备份、删除、恢复、语义重放、派发前权威审计与失败回滚合同                          |

上表 14 文件结果属于较早执行快照。当前未发布反馈修复工作树的最新全量证据为 Desktop
249 files / 1,855 passed / 1 skipped / 0 failed，Data 421 passed / 0 failed，Rust 160 passed /
1 ignored / 0 failed，production Chromium 12/12；最终 production build 为 53 files /
6,739,800 bytes，门禁 payload 为 6,739,000 / 7,340,032 bytes。付费 infrastructure 10 files /
96 tests、AI Core 16 files / 120 tests 属于各自已记录的较早稳定快照。当前修复的完整
当前未发布反馈修复工作树的完整 `pnpm.cmd release:check` 已以退出码 0 通过；发布候选链仍为
`NOT_RUN / NOT_RELEASED`，不得用旧快照冒充。精确命令见 `docs/execution/TEST_RESULTS.md`。独立审查批准 Data `0060`–`0064` 的 content-free ledger、显式付费
派发权威和零自动调用接线；真实 Provider A/B、可信 `ELIGIBLE_FOR_REVIEW`、人工批准和真实 Tauri
冷启动没有执行。这些本地测试不能外推为 `VERIFIED`。

## 9. 2026-08-13 本轮受限 smoke 结果

本轮不重做 Novel Skill 体系，也不执行专家区的 192 次付费 A/B 或 2,496 项人工评分。即使该基础
设施仍可由作者显式展开，验收脚本和自动化也没有替作者创建商业授权或点击开始。本轮实际执行范围为：

1. 使用真实临时 SQLite、零 Provider 调用验证 Scene Craft 初始关闭 → 显式启用 → 重开仍启用 →
   显式关闭 → 再次重开仍关闭；
2. 使用一个本地 mocked generation，固定目标 300 字符、上限 768 tokens，产生 200–400 个中文字符；
   输出只进入隔离 Candidate，正文与不可变版本在生成、拒绝和重开后都不变；
3. context trace 精确记录 `Scene Craft / 1.0.0 / included`；拒绝决定跨 runtime 重开保留，关闭 Skill
   只影响后续调用，历史 trace 不被删除；
4. 两个测试文件共 28 项通过；没有网络、真实 Provider、fallback、自动 retry 或付费 runner 调用。

全部 Core/Genre 继续 `EXPERIMENTAL`、`defaultEnabled=false`。只有未来独立评测轮次得到完整真实
证据并由作者另行批准，才允许讨论默认值。该本地 mock 只证明 SQLite 持久化、snapshot/trace 和
Candidate 围栏，不证明模型可调用性或 Skill 质量提升。

## 10. 上线顺序、回滚与未完成项

### 10.1 安全上线顺序

1. 保持现有实验开关默认关闭，先实现不绕过 trace/Candidate/项目围栏的受控 Runner；
2. A/B 至少在两个当前真实可用文本模型档位完成 192 个计划 cell，保存 exact invocation receipt、失败 attempt、Candidate 与 Skill snapshot；
3. 完成人工评分并证明 blocking 指标无回归；缺失成本、延迟或安全证据即保守失败；
4. 验证关闭后下一次 snapshot 变化、StoryFact 不污染、Candidate/版本安全与真实 Tauri restart；
5. 人工产品评审通过后，才可把经过评测的具体版本改为 `active`；
6. `defaultEnabled=true` 必须另行决策，不能由评测账本或 ProjectSeed 推荐自动触发。

### 10.2 回滚

- 立即回滚：保持所有 definitions experimental/default false，并关闭项目 binding 或实验 feature gate；
- 回滚不会删除 definition/snapshot 审计记录，也不会改写已经接受的正文版本；
- 数据迁移是 forward-only，不编辑或撤销 `0060`；
- 删除项目会按外键清理 binding/snapshot，immutable definition 保留到无引用时由未来维护策略处理；
- 任一 Skill 编译、快照或派生步骤失败时，AI 调用 fail closed，手动正文和已接受版本不回滚。

### 10.3 已实现的真实评测基础与仍未执行的外部阶段

Data `0063` / Tauri `66` 已实现固定实验协议、真实连接/目录目标锁、Provider 可见输出哈希、
192-call 商业授权、分币种费用上限、跨重启派发状态、chapter-null 隔离 Candidate、受控
exact-target 串行 Runner 和本地盲评；专家设置页的准备、报价、授权和恢复均为零调用，只有作者
另行点击“手动开始 192 次付费调用”才能进入供应商边界。Data `0064` / Tauri `67` 另以前向 sidecar
冻结完整 content-free payload authority 子哈希、能力/最终派发锁和逐 payload 预派发估价，旧记录或
备份无法重算时 fail closed。上述实现仍只是可审计基础设施，不是 Provider 观察值或质量结论。

明确未完成：

- 五个 Genre 定义的真实跨模型 A/B；
- 两个当前真实可用模型档位的 192 次 A/B 输出与 2,496 项人工盲评；
- 用户偏好对 Skill 强度/推荐的可见映射；
- 真实 Tauri 冷启动下的端到端 Skill 生成旅程。

本地基础设施会证明四个 arm 除 Skill treatment 外使用同一 base prompt、最终 messages、上下文基线
与请求参数；live 阶段核对 connection/catalog/provider/model；把 Provider 实际可见输出哈希原子绑定
到隔离 Candidate；拒绝专用项目内不属于当前 run 的额外 Candidate/trace；并让 13 项评分绑定固定
rubric 内容哈希、盲评顺序和 reviewer receipt。真实运行仍须由作者逐次确认两个目标、报价和商业授权；
任何未知价格、权限漂移、崩溃后发送状态不明或恢复证据不完整都会停止整次 run，不能以自动重试补齐。

在这些事项完成前，Novel Skill 的产品状态是**安全基础与实验性 opt-in 运行链已实现，默认上线门禁未通过**，不是 `VERIFIED`。
