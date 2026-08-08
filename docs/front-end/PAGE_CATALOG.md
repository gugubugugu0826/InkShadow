# InkShadow 前端页面、文件与内容目录

> 基于源码快照：2026-08-09  
> 文档状态：`SUPPORTING_CURRENT`  
> 应用版本：`0.2.0`；设计基线：`DESIGN v0.3.1b`  
> 路由权威来源：`apps/desktop/src/app.tsx`  
> 本文只描述当前实现；它不证明 P01–P44、真实供应商或 Windows 目标矩阵已经验收

## 1. 页面范围结论

当前真正包含用户界面的应用只有：

- `apps/desktop`：主产品界面，React + Vite + Tauri，使用 Hash Router；
- `apps/web`：独立的浏览器 Guest 加密写作单页，没有路由。

以下应用当前没有用户页面：

- `apps/cloud-api`：纯服务端 HTTP/API；
- `apps/android`：只有 `core` 与 `android-keystore`，没有 Activity、Fragment、Compose 或
  Android UI 模块。

Desktop 在 `apps/desktop/src/app.tsx` 中注册了 33 个明确路径和 1 个通配状态页。`/` 与
`/start` 显示同一个启动页。未知路径显示“页面不存在”、当前地址和返回项目列表入口，不再
静默重定向。

## 2. Desktop 入口与壳层

| 文件                                                           | 职责                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/desktop/index.html`                                      | Vite HTML 入口                                                     |
| `apps/desktop/src/main.tsx`                                    | 挂载 React 根组件                                                  |
| `apps/desktop/src/app.tsx`                                     | 懒加载页面、注册路由、Feature Flag 守卫                            |
| `apps/desktop/src/appearance-preference.tsx`                   | 三态外观偏好、挂载前应用和系统变化同步                             |
| `apps/desktop/src/runtime-context.tsx`                         | 创建和注入 `DesktopRuntime`                                        |
| `apps/desktop/src/components/app-error-boundary.tsx`           | 捕获未处理界面错误，提供重试和返回安全入口                         |
| `apps/desktop/src/components/command-palette.tsx`              | `Ctrl/Cmd+K` 快速前往可用页面；支持键盘选择、Escape 关闭和焦点返回 |
| `apps/desktop/src/components/desktop-shell.tsx`                | 顶栏、导航、页面标题、在线状态和内容壳                             |
| `apps/desktop/src/components/desktop-persistence-boundary.tsx` | 路由和窗口关闭前刷新待落盘数据                                     |
| `apps/desktop/src/styles.css`                                  | Desktop 全局样式                                                   |

运行时有两种模式：

- `tauri`：正式桌面边界，使用 SQLite、系统凭据库、项目密钥、原生模型和文件选择器；
- `browser-development`：浏览器调试模式，部分能力使用内存或 `localStorage`，其余明确显示
  不可用，不能当作发行版数据层。

`AppShell` 只渲染一个 `<main>` 主地标。应用壳层锁定为视口高度，右侧主内容区独立滚动；
设置等长页面不会再被页面根节点截断。窄于 60rem 时，主导航变为抽屉：按钮提供
`aria-controls`/`aria-expanded`，打开后显示遮罩、圈定焦点并隔离背景，可用 Escape 或遮罩
关闭，关闭后恢复原焦点。

启动页、登录页和三条创建旅程不使用 `AppShell`，但会在视口内各自纵向滚动。这些页面在
矮窗口下使用安全居中，避免顶部内容因整页垂直居中而移出可见区。

`DesktopShell` 的常驻导航包括作品库、开书、任务和设置；社区模板和团队入口只在对应
Feature Flag 开启时显示。进入项目范围后，普通一级导航固定为正文、规划、设定、检查四区。
搜索、故事关联、从正文更新设定、素材、多智能体、微调、翻译/短剧和同步等能力通过页面内
“高级工具”或条件入口渐进披露。团队模板入口只在团队项目上下文且运行时可用时显示。

每次完整路由切换都会更新 `document.title`，并把焦点移到新页面的一级标题；设置页等页内
哈希导航由目标页面自行滚动并聚焦，不会被壳层重新抢走焦点。顶栏标题已覆盖素材、团队审阅、
团队模板及其他已注册路径。

## 3. 启动与账户页面

| 路由                   | 页面文件                                                                      | 页面内容与主要操作                                                                                                                                                                        | 条件与数据来源                                                                            |
| ---------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/`、`/start`          | `apps/desktop/src/pages/start-page.tsx`                                       | 最近创作和三个核心入口：从想法开始、导入小说、专业创建；恢复备份和作品库作为辅助入口                                                                                                      | 本地项目仓库、`featureFlags.cloudIdentity`                                                |
| `/create/idea`         | `apps/desktop/src/pages/idea-journey-page.tsx`                                | 一句话开书、原位 AI 连接、开头 AI 建议版本、自己写/本地示例、一次一个问题、选项/自定义/跳过/返回/重生成/保留和中断恢复；创建前可编辑书名与故事摘要并查看开头来源、创作方向和回答/跳过摘要 | `runtime.creativeJourneys`、`runtime.projectSeeds`、Model Hub、系统凭据库、候选与版本用例 |
| `/create/import`       | `apps/desktop/src/pages/import-journey-page.tsx`                              | 安全导入；真实章节读取；证据化人物/关系/世界/时间线/POV/风格/事件/伏笔/剧情状态分析；目标、代表段落试改、Diff、可编辑规则和逐章独立建议版本                                               | 导入用例、Model Hub、统一 StoryFact、章节/版本/候选仓库；分析可跳过                       |
| `/create/professional` | `apps/desktop/src/pages/professional-create-page.tsx`                         | 项目名起步，按需展开人物、世界、关系、时间线、规则、大纲、POV、风格、AI 分工和检查配置                                                                                                    | 本地项目、统一 StoryFact 与专业配置流程                                                   |
| `/auth/login`          | `apps/desktop/src/pages/cloud-login-page.tsx`、`cloud-identity-auth-flow.tsx` | 登录、注册、邮箱验证码、忘记密码、密码重置、设备命名；会话检查失败时可重试或继续本地使用                                                                                                  | 云身份开关和服务必须可用；已有本机会话时进入项目页                                        |

`cloud-identity-auth-flow.tsx` 是登录页内部状态机，不是独立路由。URL 只承载页面位置，云会话
凭据由原生安全边界管理。

云会话检查失败不会再静默返回启动页。页面会说明本地项目仍可使用，并提供“重新检查”和“暂不
登录，继续本地使用”两条明确路径。

一句话开书在用户选择“保留开头，确认创建”后进入“都准备好了，看一眼全貌”摘要页。书名上限
120 字，故事摘要上限 4000 字；用户可返回继续调整，创建后得到本地项目、空白第一章和一条
`ready` 状态的 AI 建议版本。开头来自真实供应商时显示供应商与模型；未连接或调用失败时只标为
“本地草案（未调用云端 AI）”。用户明确采纳前，稳定正文保持为空；已有候选的章节、内容或状态
与当前旅程不一致时，创建流程失败关闭，不覆盖正文。

没有可用开书模型时，“去连接 AI”在当前页打开 `quick-ai-connection-drawer.tsx`。快捷列表当前
包括 DeepSeek、OpenAI、阿里云百炼/Qwen、火山方舟/豆包、Ollama、智谱 GLM 和自定义
OpenAI-compatible。能可靠列目录的连接使用真实模型目录；百炼、豆包、GLM 等需要账号模型或
Endpoint ID 的连接要求用户明确填写，并用不含作品内容的固定短句验证文本能力，不根据模型名
猜测。失败可返回修改、重试、返回模型列表改选或跳过。新 Key 先使用一次性 staging 凭据，
非秘密目录保存成功后才提交到正式系统凭据项；浏览器预览不会保存凭据。

三条创建入口都会维护同一类 `ProjectSeed` 创建输入：前提、类型、基调、人物、关系、世界、
冲突、风格、视角、禁止项、当前方向、初步大纲和改写规则。每个字段同时记录来源与
`confirmed`、`unconfirmed` 或 `skipped` 状态，因而 AI 推测、用户确认和主动跳过不会混为一谈。
项目创建前由可恢复旅程快照负责，项目创建后保存到项目自己的 `runtime.projectSeeds`；它不是
稳定正文，也不是已经确认的 StoryFact。

导入页的作品分析只保存通过严格结构和原文位置校验的结果。所有模型提取都先进入统一 StoryFact
待确认队列，不直接修改正文或正式设定；事件使用 `causal_event` 候选格式。分析按章节和类别保留
进度，失败时可重试或跳过，刷新后不会自动重复模型调用。详细边界见
`docs/product-rebuild/05-PHASE-1-IMPORT-WORK-ANALYSIS.md`。

## 4. 项目、构思与市场

| 路由           | 页面文件                                              | 页面内容与主要操作                                                                                                                                            | 条件与数据来源                                                                        |
| -------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/projects`    | `apps/desktop/src/pages/projects-page.tsx`            | 搜索；进行中、已归档、回收站标签；新建、重命名、归档、恢复编辑、移入回收站、恢复；真正首次使用时显示“从想法开始/导入已有小说”，已有导入流程时显示已保存检查点 | `runtime.useCases` 中的项目用例；导入检查点窄读 `inkshadow.import-rewrite-journey.v2` |
| `/ideation`    | `apps/desktop/src/pages/ideation-page.tsx`            | 引导开书、快速开书、活跃草稿；九步构思；保存、跳过、锁定、本地结构建议和最终原子创建项目                                                                      | `runtime.story.ideationDrafts`、`ideationService`；结构建议由本地规则生成             |
| `/marketplace` | `marketplace-route-page.tsx` → `marketplace-page.tsx` | 已安装模板、在线目录、标题/作者/标签搜索、类型筛选、安装、更新、带可恢复性说明的卸载确认和结果反馈                                                            | `runtime.marketplace`；远程市场关闭或离线时仍可查看已安装副本                         |

九步构思当前依次为：

1. 类型与基调；
2. 目标读者；
3. 核心创意；
4. 主角驱动力；
5. 世界骨架；
6. 关键角色；
7. 情节路线；
8. 开篇钩子；
9. 输出规格。

市场路由当前没有向 `MarketplacePage` 传入发布或举报回调，因此相关入口不会显示；这不是
“接口已存在即页面可用”。

项目的新建与重命名输入框会在 Enter 提交前检查中文输入法组合态，确认候选字不会误触发提交。
只有进行中、归档和回收站三个状态都为空时才显示首次使用入口；仅当前标签为空、搜索无结果，或
作品只在归档/回收站时，会说明真实状态并提供清除搜索、查看归档或查看回收站，不会伪装成全新
作品库。隐藏标签不会重复渲染当前结果。

归档、恢复编辑和恢复项目完成后会显示明确反馈。移入回收站前必须经过确认对话框，进行中作品
还可改为归档；确认移入后保留既有 30 天软删除周期、显示可恢复期限，并提供“撤销”。作品库的
导入流程卡只读取已经落盘的“已导入、分析完成数/总数、改写目标、试改、规则”检查点。文件读取
与安全解析的实时进度只在导入页显示，离开后不会推测或伪造百分比。

社区市场未启用、离线或加载失败时，搜索、类别等在线目录控件不可操作，已安装副本仍可查看和
使用。卸载本地副本必须先确认源模板下架后的不可恢复风险，完成后显示结果通知。

## 5. 项目工作区与内容

| 路由                              | 页面文件                                                                        | 页面内容与主要操作                                                                                                                                                                                                                                    | 条件与数据来源                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `/projects/:projectId`            | `workspace-page.tsx`                                                            | 章节列表、正文摘要、字符数、版本和隐私标记；新建普通或私密章节；进入搜索、大纲、故事治理、素材和条件启用的高级能力                                                                                                                                    | 项目/章节仓库、`createChapter`；归档或回收站项目只读                                                                             |
| `/projects/:projectId/search`     | `project-search-page.tsx`                                                       | 关键词、向量、关系、规则混合搜索；索引状态、评分拆分；重建索引、明确重建向量、停用并清除向量、打开来源；只显示最新请求结果                                                                                                                            | `runtime.search`；远程向量动作先说明数据去向                                                                                     |
| `/projects/:projectId/graph`      | `project-graph-route-page.tsx` → `causal-story-links-page.tsx`                  | 普通用户的故事关联与因果剧情试演：确认事件/关系、精确原文证据、确定性影响范围、锁定规则安全编译、独立沙盒结果；`?legacy=1` 仅在专家开关下查看旧 GraphRAG 投影                                                                                         | `runtime.story.causalGraph`、`runtime.story.causalWhatIf`；模型、因果证据或全部锁定规则任一门禁不足时明确失败                    |
| `/projects/:projectId/extraction` | `authoritative-extraction-route-page.tsx` → `authoritative-extraction-page.tsx` | 扫描稳定章节、可恢复任务队列、黄金样本门禁、人工候选；接受、修改后接受、暂缓、拒绝、恢复审核和撤销接受                                                                                                                                                | 需要 `authoritativeExtraction`、相应运行时和有效 UUID；接受后联动 GraphRAG                                                       |
| `/projects/:projectId/materials`  | `project-materials-page.tsx`                                                    | 素材正文、来源、作者、网址、许可、权利依据、标签、生成/训练授权；章节引用；软删除、恢复、合并重复素材                                                                                                                                                 | 故事素材仓库、引用仓库和服务；非活动项目只读                                                                                     |
| `/projects/:projectId/outline`    | `story-outline-page.tsx`                                                        | 书→卷→章三层大纲；创建、编辑、排序和锁定；AI 生成全书方向或章节场景拆解。候选同时显示当前正式简介与固定结构化条目，可逐项勾选并保留原简介，也可编辑后整体替换、拒绝；逐项采纳先锁定选择和基线，在途时只能继续同一次采纳；两种采纳都只更新目标节点简介 | 大纲仓库与服务、`runtime.story.storyPlanning`；非活动项目只读；AI 规划需 Model Hub 条件；旧候选无简介基线时不开放逐项采纳        |
| `/projects/:projectId/story`      | `story-governance-page.tsx`                                                     | 统一事实与治理、人物/世界对象聚合、实体别名人工消歧、章节摘要、旧作品当前版本回填计划、故事变化、AI 参考历史、写作偏好、旧记忆/正式记录和人工记忆合并；旧自由 What-if 分支与大纲草稿仅保留只读历史，新入口统一前往因果故事关联                        | `runtime.story`、`runtime.contextTraces`；模型能力按项目开关与路由条件运行；别名冲突、知识取得、记忆合并和回填都需要明确人工决定 |
| `/projects/:projectId/checks`     | `project-checks-page.tsx`                                                       | 选择章节运行确定性矛盾、声纹/POV、多线/伏笔/节奏；逐类披露已实际检查或证据不足未检查；保存绑定当前不可变版本的检查快照；提醒携带证据并可持久忽略、允许或撤销；分栏显示只读 AI 模糊复核与内容质量建议；未运行不冒充通过                                | 当前不可变章节版本、严格 StoryFact/投影证据、因果图；处置还需复核当前检查事实与证据签名；AI 分栏还需 Model Hub 路由和能力        |
| `/projects/:projectId/context`    | `context-sources-page.tsx`                                                      | “本次参考”历史：每次生成采用/舍弃了哪些来源、为什么选择及预算信息；不重复保存正文、创作指令或 AI 回复                                                                                                                                                 | `runtime.contextTraces`；项目 ID 必须有效                                                                                        |

### 5.1 页面主要内容

`workspace-page.tsx` 是单项目首页。它不承载正文编辑，而是汇总项目状态并提供章节和各领域
入口。新建章节时可勾选“创建为私密章节”；该模式从首个稳定版本开始阻止云端投影，没有已验证
本地模型时，需要读取正文或全书资料的模型处理会安全停止。只要作品仍保留任一私密章节，远程
Embedding、Rerank、审稿、续写、改写、规划、连续提取和剧情试演都会在真实派发前按项目级
authority 失败关闭；纯本地关键词搜索、编辑、版本、备份和导出不受影响。

`project-search-page.tsx` 显示每条结果的关键词、向量、关系和规则评分。向量服务可能需要
远程发送内容，页面必须保留显式数据出口提示。

`project-graph-page.tsx` 同时提供图形和线性列表，确保关系数据在图形不可访问时仍可阅读。
图谱是可重建的派生投影，不应被当作唯一权威数据。

`authoritative-extraction-page.tsx` 只从稳定章节生成待审候选。候选不会因任务完成而自动写入
正式设定，必须经过人工决定。

`project-materials-page.tsx` 对来源、授权和引用证据进行结构化保存。删除与合并不能破坏已有
章节引用证据。

`story-governance-page.tsx` 的“章节摘要与长程记忆”和“手动保存后的故事变化识别”都默认关闭。
启用后也只有手动保存新版本会调用模型，自动保存永不发送正文；用户仍可逐章显式重建摘要或
重新识别最近一章。连续状态的重大变化保持待确认，普通变化可撤销，所有证据都绑定不可变版本。

同页“AI 参考记录”列出最近 50 次上下文编译摘要，可展开采用/舍弃资料、来源、层级和估算预算；
记录不保存正文、Prompt、模型回复或向量。旧自由 What-if 分支和大纲草稿仅供查看，不再允许新建、
补写影响、提升或丢弃；新的试演统一进入 `/projects/:projectId/graph`，先按确认因果链计算影响范围，
全部锁定规则无法纳入安全预算时不会调用模型。

## 6. 编辑器与 AI 候选

| 路由                                                          | 页面文件                                                                                | 页面内容与主要操作                                                                                                                              | 条件与数据来源                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `/projects/:projectId/chapters/:chapterId`                    | `editor-page.tsx`                                                                       | 正文编辑、自动/手动保存、撤销重做、查找替换、排版、光标与滚动状态、版本历史、崩溃草稿、章节隐私、生成预检、上下文预算/来源、候选质量提示和 Diff | 项目、章节、版本、恢复草稿、候选、Model Hub、生成治理、上下文 trace 和任务中心    |
| `/projects/:projectId/multi-agent-review`                     | `multi-agent-review-route-page.tsx` → `multi-agent-review-page.tsx`                     | 项目级多智能体审查；讨论、结论、来源、隔离候选、开始/停止/重启、候选决定、历史导出                                                              | `runtime.multiAgentReview`；功能关闭时只允许查看/导出现有历史                     |
| `/projects/:projectId/chapters/:chapterId/multi-agent-review` | 同上，另有 `multi-agent-review-route.ts`                                                | 章节级审查；接受候选后以 `?candidate=` 返回编辑器比较                                                                                           | 同上                                                                              |
| `/projects/:projectId/fine-tuning`                            | `fine-tuning-governance-route-page.tsx` → `fine-tuning-governance-page.tsx`             | 实验性微调治理；冻结合规来源、数据集清单与审批、硬上限、本地训练预检、可恢复队列、真实评测、候选登记、部署/回滚和审计                           | 需要 `runtime.fineTuningGovernance`；远端训练固定关闭，执行能力缺失时保持治理只读 |
| `/projects/:projectId/chapters/:chapterId/extensions`         | `governed-creative-extensions-route-page.tsx` → `governed-creative-extensions-page.tsx` | 翻译与短剧；固定章节来源版本；目标语言/语气/术语；剧集格式；远程发送确认、预算预检、停止、重试、采纳独立成果和导出历史                          | 只在桌面安全运行时可用；翻译和短剧分别受开关控制                                  |

### 6.1 编辑器内容

`editor-page.tsx` 是当前最大的前端页面，包含：

- 稳定正文编辑和本地持久化；
- 自动保存、手动保存和离开前刷新；
- 中文输入法组合态保护；
- 撤销、重做、字面量查找与替换；
- 字体、字号、行距和版心偏好；
- 光标、选区和滚动位置恢复；
- 追加式章节版本历史和恢复；
- 崩溃恢复草稿；
- 普通/本地私密章节标记及独立隐私切换确认；
- 模型容量、路由、预算与生成前预检；
- 生成任务取消、重试和失败恢复；
- AI 候选隔离；
- 选中 1–12,000 个 UTF-16 字符后填写一次具体改写要求；选区、当前不可变版本和原文
  SHA-256 在发送前后都要一致，结果只保存改写片段和原始选区锚点为 `polish` 建议版本，再进入现有 Diff；
- 每次候选生成后的本机重复度质量门禁；只对可证明的重复项给出警告，不伪造文笔、POV 或一致性分数；
- 建议文本可在隔离区编辑并保存，重开后仍是未采纳建议，不会先写正文；
- 保存建议、接受和拒绝都携带当前界面展示的 Candidate 修订号；另一窗口保存新版后，旧界面的
  修改或决定会提示版本冲突，不会接受用户未看过的文本；逐章导入草稿也持久保存其展示修订号；
- 旧逐章草稿缺少 Candidate 修订号时，单章重生成和整批重生成都会在模型派发前停止；批次的
  `candidateId + candidateRevision` 在生成返回后同步写入本机存储，写入失败会保留当前页可见指针、
  停止后续模型调用并保留中断恢复标记；
- 续写只允许插入生成时光标，选区改写只允许替换生成时选区；整章改写明确提供替换整章、追加章末、保存为新草稿和取消。旧完整文档建议继续兼容逐处接受、保留稳定正文和显式应用策略。

手动保存成功会先按稳定版本 ID 登记可恢复的派生任务：本地搜索和故事关联始终更新，章节摘要与
连续状态识别按项目开关运行；自动保存只落盘，不会产生模型费用或把正文发送给供应商。模型输出
不会覆盖正文，失败也不撤销已经成功的本地保存。

作品只要仍保留任一私密章节，所有读取正文、StoryFact、因果关系或其他全书资料的 AI 操作都只允许
通过已验证的本地模型执行；真实派发前还会复核包含保留章节集合、当前版本、状态与隐私修订的项目指纹，
条件不满足时以 `PRIVATE_CHAPTER_LOCAL_ONLY` 停止并发送 0 字。切换为
私密模式会阻止待处理明文投影并移除尚未确认发送的同步任务，但不能撤回过去已经完成的外部
传输；本地记录中“0 条云端确认回执”也不是从未上传的证明。切回普通章节只允许未来按设置使用
联网 AI、同步与导出，不会立即发送正文，也不会制造新的正文版本。

关键共享组件：

| 文件                                                           | 用途                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/desktop/src/components/candidate-diff-viewer.tsx`        | 对候选差异逐处接受或保留稳定正文                                                             |
| `apps/desktop/src/components/crash-recovery-dialog.tsx`        | 恢复草稿、保留稳定正文或另存副本                                                             |
| `apps/desktop/src/components/desktop-persistence-boundary.tsx` | 离开页面或关闭窗口前刷新待写入数据，失败时阻止离开                                           |
| `apps/desktop/src/components/chapter-summary-panel.tsx`        | 章节摘要、连续状态开关、重建、状态与证据治理                                                 |
| `apps/desktop/src/components/context-history-panel.tsx`        | 内容最小化的 AI 上下文历史列表与详情                                                         |
| `apps/desktop/src/components/story-planning-panel.tsx`         | 显示当前简介与候选差异；固定条目可勾选后安全追加，亦可编辑、拒绝或整体采纳的 AI 剧情规划候选 |
| `apps/desktop/src/components/quick-ai-connection-drawer.tsx`   | 开书页原位连接、模型选择、失败恢复与 AI/自己写/示例分流                                      |

多智能体页面当前提供头脑风暴、大纲、角色、世界观、商业性和剧情规划类型，以及规划者、
执笔者、批评者、连续性审校和编辑角色。公开讨论与隔离候选分开保存。

微调页面不会自动把训练产物投入使用。候选必须经过真实本地评测、人工登记审批和目标角色
部署审批；页面不生成虚构分数，也不上传训练正文。

翻译和短剧结果也是隔离候选，不会覆盖源章节；页面以源版本 ID 和内容校验值固定输入。

## 7. 同步、密钥与冲突

| 路由                                  | 页面文件                                                                        | 页面内容与主要操作                                                                                           | 条件与数据来源                                               |
| ------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `/projects/:projectId/sync`           | `project-sync-route-page.tsx` → `cloud-sync-control-panel.tsx`                  | 未启用、等待、同步中、已同步、暂停、离线、重试、冲突、密钥、会话、配额和版本状态；立即同步、重试、暂停、恢复 | `runtime.cloudSyncControl`；缺失时显示未启用                 |
| `/projects/:projectId/sync/conflicts` | `sync-conflict-resolution-route-page.tsx` → `sync-conflict-resolution-page.tsx` | 三方比较共同基线、本机和远端；保留本机、采用远端、两个都保留、手动合并；确认后创建新稳定版本                 | `runtime.syncConflictResolution`；缺少同步或密钥授权时不可用 |
| `/settings/sync`                      | `sync-security-page.tsx`，内嵌 `cloud-deletion-security-card.tsx`               | 本机身份、逐项目密钥、恢复码、云同步授权、可信设备、会话撤销、项目/账户永久删除与宽限期                      | 项目密钥、同步注册、账户和删除生命周期运行时                 |

冲突页不允许远端版本静默覆盖本机版本。所有解决方案都要产生可追踪的新稳定版本；远端删除
冲突单独阻止，不能被普通文本合并掩盖。提交某条冲突的解决方案期间，左侧冲突选择会锁定，
避免提交对象和当前显示对象错位。

浏览器开发模式不会模拟设备私钥、恢复码或云端成功。

## 8. 设置、迁移与诊断

| 路由        | 页面文件            | 页面内容与主要操作                                                                                                                                                                                     | 条件与数据来源                                                                                                                                                                  |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/settings` | `settings-page.tsx` | 外观；正文阅读与自动保存；数据与隐私；按项目忘掉全部 AI 记忆；Model Hub 普通/专家模式、供应商、能力、小说任务分工；图片/基础评测；旧模型兼容；同步安全、数据库检查、备份恢复、安全更新、诊断和导入导出 | `useAppearancePreference`、`editor-preferences-store`、`runtime.story.memoryService`、`modelHub`、`credentials`、`modelGateway`、`modelRouting`、`maintenance`、`secureUpdater` |

设置页内嵌：

| 文件                                                               | 内容                                               |
| ------------------------------------------------------------------ | -------------------------------------------------- |
| `apps/desktop/src/pages/secure-update-card.tsx`                    | 检查签名更新，验证并隔离暂存更新包；当前不执行安装 |
| `apps/desktop/src/components/data-transfer-panel.tsx`              | 安全导入导出和领域报告                             |
| `apps/desktop/src/components/model-hub-evaluation-panel.tsx`       | 不含作品内容的本地基础模型探针                     |
| `apps/desktop/src/components/model-hub-image-generation-panel.tsx` | 受能力/隐私门禁的图片生成与安全另存                |

页面顶部“设置分区”目录可直达并聚焦以下锚点：

- `#appearance`：跟随系统、浅色或深色；
- `#data-privacy`：数据与隐私；
- `#model-center`：模型中心；
- `#model-routing`：模型角色路由；
- `#sync-security`：同步安全；
- `#local-maintenance`：本地数据维护；
- `#secure-updates`：安全更新；
- `#diagnostics`：脱敏诊断；
- `#data-transfer`：导入与导出。

Model Hub 默认进入普通模式：连接供应商、测试连接、同步/确认模型并选择智能推荐、高质量、
经济模式、本地隐私或完全自定义方案。专家模式才展开 Base URL、受限路径/Header、超时、重试、
能力证据以及每项小说任务的主/备用模型、费用和隐私覆盖。项目 AI 记忆区要求先明确选择作品；
“清空”会关闭该项目自动学习并排除记录，保留来源与审计，不跨项目物理删除。

`data-transfer-panel.tsx` 当前支持：

- 导入 TXT、Markdown、DOCX、EPUB、静态 HTML、可提取文本的 PDF 和 InkShadow Bundle；
- 拒绝宏、脚本、活动内容、危险压缩包以及需要 OCR 的扫描 PDF；
- 导出 TXT、Markdown、EPUB、DOCX、图像型 PDF 和 Bundle；
- 导出角色、世界观、伏笔、时间线、大纲、审阅和 AI 用量报告。

普通项目导出默认排除私密章节以及可定位的相关生成、提取和检查记录；页面会显示排除数量。
只有用户显式勾选“包含私密章节”后才把它们纳入导出，若项目只有私密章节且未勾选则停止导出，
不会生成看似成功的空文件。

安全更新卡只完成检查、下载、签名/范围/摘要验证和隔离暂存，并在清单提供安全 HTTPS 地址时
显示官方发行说明。当前版本不会运行安装包、自动安装或自动回退；发布者 Authenticode 尚未
验证时，不得在文档中把它描述为自动安装器。

## 9. 团队与 Studio

四条团队路由统一受 `featureFlags.teamCollaboration` 控制。开关关闭时显示“团队协作尚未
启用”；开关开启也仍需联网、登录、成员权限、项目 assignment 和项目密钥。

| 路由                                           | 页面文件                                                                  | 页面内容与主要操作                                                                                                                                                     | 条件与数据来源                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `/teams`                                       | `studio-team-page.tsx`                                                    | 创建/选择团队；接受邀请；成员与角色；移除成员；创建邀请；项目 assignment；项目密钥 envelope 发放与当前设备验收；进入用量、审阅和模板；角色、成员移除和项目权限变更确认 | 云团队、云身份、项目密钥和 Studio 运行时                                    |
| `/teams/:teamId/usage`                         | `studio-usage-page.tsx`                                                   | 团队月度用量、项目用量、并发租约、价格版本、预算与项目覆盖、最近 50 条账本                                                                                             | `runtime.cloudAiUsage`；可用 `?projectId=` 切换项目范围                     |
| `/teams/:teamId/projects/:projectId/reviews`   | `studio-review-route-page.tsx` → `studio-review-page.tsx`                 | 加密审阅列表与线程；创建审阅、批准/拒绝、评论/建议、回复、解决线程和替换建议决定                                                                                       | 每次挂载从认证会话重新解析团队、成员、assignment 和项目密钥；URL 不授予权限 |
| `/teams/:teamId/projects/:projectId/templates` | `studio-team-templates-route-page.tsx` → `studio-team-templates-page.tsx` | 加密模板历史；创建草稿、发布、应用、克隆、归档、导出；本地成功但云回执失败时只重试回执                                                                                 | 云会话、项目密钥、权限、本地项目修订和写状态共同决定                        |

团队角色调整、成员移除、授予或撤销项目权限不会因一次选择立即写入；页面先显示目标成员、
变更前后状态和影响说明，用户确认后才提交，服务端仍会复核权限与修订号。团队模板页面的标题、
状态、操作、错误和说明文案已统一为中文。

## 10. 后台任务

| 路由     | 页面文件                | 页面内容与主要操作                                                                                                                                      | 条件与数据来源                                                            |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `/tasks` | `task-center-page.tsx`  | 任务/通知标签；每 5 秒刷新；状态、进度、尝试次数、失败动作；取消确认；符合条件的已接受版本后台整理可“立即重试”；单条/全部已读；跳回章节、模型中心或诊断 | `runtime.taskCenter`、`runtime.generationGovernance`                      |
| `/usage` | `usage-center-page.tsx` | 只读本地调用账本；按时间、作品、任务、供应商和模型筛选/分组，显示 token、可确认费用估算、隐私/预算信息和近期调用；支持刷新与错误保留旧结果              | `runtime.usageCenter`；只在 Tauri 读取 SQLite，浏览器开发模式显示能力受限 |

浏览器开发模式的任务中心使用 `localStorage`；Tauri 桌面版使用 SQLite。

接受 AI 建议、导入章节、恢复旧版本或明确手动保存成功后，稳定正文先以不可变版本提交，再由
`story.accepted-version.process` 后台任务尽力更新本地搜索索引、章节摘要、故事设定候选和因果投影。
任一派生步骤失败都不回滚或修改已接受正文；缺少模型或路由时明确记为跳过，不伪造供应商结果。
只有处于 `waiting_retry`、失败标记允许重试且项目/章节/版本/来源元数据完整的该类任务才显示
“立即重试后台整理”，不符合条件时不会用不完整信息重新执行。旧作品回填必须先看只读计划并
明确确认，只为当前稳定版本登记 `historical_backfill` 任务；worker 每轮最多执行 5 条历史回填。
回填计划区同时区分“涉及章节数”和“待登记后台任务数”：关闭后再开启的摘要/设定识别只登记
缺失阶段，已成功阶段不重复。批量登记中途失败时，提示“部分现有章节任务已登记”，列出已登记和
剩余数量并刷新计划；每条登记前都会重查章节/隐私/版本/校验值、项目开关和任务权威，中途变化则
显示计划已过期并停止。该复核不是原子锁；若作者恰在复核与入队之间保存新版本，旧任务会保留为
审计记录，但执行时会在模型发送前再次拦截，且不能改写正文。仅本机章节的远程路由发送 0 字并
失败关闭，已验证本地模型仍可继续处理。

## 11. `pages/` 文件完整分类

### 11.1 直接由路由加载

- `start-page.tsx`
- `idea-journey-page.tsx`
- `import-journey-page.tsx`
- `professional-create-page.tsx`
- `cloud-login-page.tsx`
- `projects-page.tsx`
- `ideation-page.tsx`
- `marketplace-route-page.tsx`
- `workspace-page.tsx`
- `project-search-page.tsx`
- `project-graph-route-page.tsx`
- `authoritative-extraction-route-page.tsx`
- `project-materials-page.tsx`
- `story-outline-page.tsx`
- `story-governance-page.tsx`
- `project-checks-page.tsx`
- `context-sources-page.tsx`
- `project-sync-route-page.tsx`
- `sync-conflict-resolution-route-page.tsx`
- `multi-agent-review-route-page.tsx`
- `fine-tuning-governance-route-page.tsx`
- `editor-page.tsx`
- `governed-creative-extensions-route-page.tsx`
- `settings-page.tsx`
- `sync-security-page.tsx`
- `studio-team-page.tsx`
- `studio-usage-page.tsx`
- `studio-review-route-page.tsx`
- `studio-team-templates-route-page.tsx`
- `task-center-page.tsx`
- `usage-center-page.tsx`

### 11.2 路由包装页使用的主体页面

- `marketplace-page.tsx`
- `project-graph-page.tsx`
- `authoritative-extraction-page.tsx`
- `cloud-sync-control-panel.tsx`
- `sync-conflict-resolution-page.tsx`
- `multi-agent-review-page.tsx`
- `fine-tuning-governance-page.tsx`
- `governed-creative-extensions-page.tsx`
- `studio-review-page.tsx`
- `studio-team-templates-page.tsx`

### 11.3 页面内部组件或路由辅助

- `cloud-identity-auth-flow.tsx`
- `cloud-deletion-security-card.tsx`
- `causal-story-links-page.tsx`
- `editor-ai-suggestion-diff-viewer.tsx`
- `secure-update-card.tsx`
- `multi-agent-review-route.ts`

以上分类不包含 `*.test.tsx`。测试文件与其同名实现对应，不是用户页面。

## 12. 样式与共享 UI

独立页面样式：

- `authoritative-extraction-page.css`
- `cloud-sync-control-panel.css`
- `fine-tuning-governance-page.css`
- `governed-creative-extensions-page.css`
- `marketplace-page.css`
- `multi-agent-review-page.css`
- `project-graph-page.css`
- `sync-conflict-resolution-page.css`

共享 UI 位于 `packages/ui/src/components/`：

- `app-shell.tsx`
- `button.tsx`
- `feedback.tsx`
- `form-controls.tsx`
- `overlays.tsx`
- `surfaces.tsx`
- `table.tsx`
- `tabs.tsx`

路由切换前需要刷新待保存数据时，`desktop-persistence-boundary.tsx` 会显示“正在保存本地更改”
状态；失败或超时会取消切换并给出恢复提示。Toast 队列优先保留错误和永久通知，网络、任务及
保存状态使用相应的 `aria-live` 状态公告。

`apps/desktop/src/qa/webview-stress-controller.tsx` 只在开发环境且
`VITE_INKSHADOW_QA_WEBVIEW_STRESS=1` 时加载，不是生产页面。

## 13. Web Guest 单页

入口：

- `apps/web/index.html`
- `apps/web/src/main.tsx`
- `apps/web/src/bootstrap.ts`
- `apps/web/src/app.tsx`

Web 没有路由，页面由状态切换：

1. 首次显示风险确认对话框；用户可接受，也可拒绝并保持正文和密钥未载入，随后重新查看风险
   说明；
2. 锁定工作区允许创建加密项目、从 `.encrypted.json` 加密副本恢复、查看完整密文项目标识、
   输入恢复材料解锁和下载密文副本；
3. 加密副本导入上限为 32 MiB；文件、严格 schema、信封绑定、恢复材料和解密后领域数据全部
   验证成功后才写入 IndexedDB，失败不保留部分项目；
4. 创建时只在页面内存显示一次性恢复材料，用户可复制或下载带项目名称、完整项目标识和创建
   时间的恢复文件，确认已经另存后才提交密文项目；
5. 解锁后可编辑章节、保存新的 AES-256-GCM 密文版本、立即锁定和下载密文副本；有未保存修改
   时，手动锁定会要求保存后锁定或明确放弃；
6. 页面隐藏或离开触发自动锁定时，会先尝试正式保存和仅含密文的临时恢复草稿，再清除可见
   正文和会话密钥。正式保存失败但临时密文成功时，下次用恢复材料解锁会自动恢复并标记为
   未保存；两种写入都失败时显示明确警告；
7. 能力面板明确说明不支持云同步、团队协作、明文外发和桌面 SQLite。

状态来源：

- `apps/web/src/application/guest-workspace-service.ts`
- `apps/web/src/contracts/encrypted-guest-project.ts`
- `apps/web/src/contracts/encrypted-guest-draft.ts`
- `apps/web/src/infrastructure/indexed-db-encrypted-project-store.ts`
- `apps/web/src/infrastructure/web-crypto-envelope-service.ts`
- `apps/web/src/infrastructure/session-project-keyring.ts`

项目名、章节标题和正文加密后才进入 IndexedDB。项目密钥和恢复材料只存在于当前页面内存；
页面隐藏、关闭、刷新或 BFCache 恢复都会锁定。页面只有一个 `h1`，工作区卡片使用 `h2`，
列表空状态等从属内容使用 `h3`，标题层级与页面结构一致。

## 14. 默认 Feature Flag

权威来源：`packages/config/src/feature-flags.ts`。

默认开启：

- `localMode`
- `byokModels`
- `localModels`
- `aiCandidateIsolation`
- `localExportWhenUnlicensed`
- `redactedDiagnostics`

默认关闭：

- `cloudIdentity`
- `cloudSync`
- `teamCollaboration`
- `advancedModelRouting`
- `graphRag`
- `authoritativeExtraction`
- `multiAgent`
- `whatIf`
- `fineTuning`
- `translation`
- `shortDrama`
- `communityMarketplace`
- `telemetry`
- `operationsAdmin`

依赖关系：

- `cloudSync` 依赖 `cloudIdentity`；
- `teamCollaboration` 依赖 `cloudIdentity`；
- `communityMarketplace` 依赖 `cloudIdentity`；
- `authoritativeExtraction` 依赖 `graphRag`；
- 本地模式、候选隔离、未授权时本地导出和脱敏诊断是安全关键开关，不能被关闭。

## 15. 静态代码不能证明的事项

- 路由存在不等于发行构建已开放对应功能；
- `navigator.onLine` 不等于 Cloud API 或模型端点可达；
- 市场目录、成员、用量、审阅、模板、模型和更新内容必须由真实服务返回；
- 文件选择器、备份恢复、系统凭据库、剪贴板和窗口行为必须在目标平台运行确认；
- 云页面还会受登录、角色、assignment、密钥版本、设备授权、订阅和服务端修订影响；
- 所有 Desktop 页面均为懒加载，并受数据库迁移完整性门禁影响；
- 初始化或迁移失败时直接显示“无法启动墨影”，不会进入普通路由；
- 浏览器运行验证不能替代 Windows/Tauri 打包版对滚动、窗口和原生焦点行为的最终复核；
- 当前安全更新链路没有安装执行器；下载校验成功仍需按已验证的官方发行说明完成后续安装。
- 页面、单元测试和本地 SQLite 验证不代表真实供应商凭据、远端模型或长篇端到端流程已经验收；
- 私密章节门禁只能阻止当前及未来由 InkShadow 发起的发送，不能证明或删除此前已到达第三方的副本。
- 当前本地迁移上限为 Data `0055` / Tauri `58`；旧页面说明中的较低数字只属于历史快照。
