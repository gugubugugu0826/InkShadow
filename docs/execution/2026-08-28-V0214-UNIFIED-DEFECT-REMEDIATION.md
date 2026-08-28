# InkShadow 0.2.14 两轮缺陷统一修复审计

> 文档状态：本轮候选源码、完整本地门禁与提交前审计记录；最终提交 SHA、干净提交发布态端到端结果和远端核对由最终交付报告绑定。  
> 更新日期：2026-08-29（澳大利亚悉尼）。  
> 执行边界：本轮不修改版本号，不创建、移动或删除标签，不构建发布安装包，不创建或修改 GitHub Release。提交自身不能预填自己的 SHA，最终值以 Git 历史和最终交付报告为准。

## 一、资料与证据边界

- 已检查用户在本轮提示词内提供的两轮缺陷摘要、当前源码、测试、迁移和现有文档。
- 用户明确说明不会再提供原始测试报告、现场数据库、截图目录、凭据、安装包或额外诊断文件。
- 因此，现场数据库、原始截图与录像、完整项目标识、完整诊断包、应用调用栈、组件调用栈、供应商原始响应和支持编号均为**未取得**。
- 提示词中的数据库字段和值仅作为复测摘要证据，本文不把它写成已经直接读取现场数据库。
- 未读取或输出凭据原文，未执行真实阿里云百炼/Qwen、真实 DeepSeek 或其他真实付费模型调用。
- 当前变更只新增向前迁移 `0082_author_recovery_records.sql`（Tauri 85），未修改迁移 0079、0080、0081 或任何已发布迁移及校验值。

## 二、21 项缺陷矩阵

| 缺陷 | 优先级 | 复现与已知证据 | 源码路径 | 准确根因 | 修复前失败测试 | 修复与当前验证 |
| --- | --- | --- | --- | --- | --- | --- |
| F2-new 专业创建资料未进入待确认设定 | P2 高 | 专业创建中的“林深、雾语”“望潮崖、浓雾海”没有成为正确分类的待确认设定；禁止项被归为人物关系。现场数据库、截图未取得。 | apps/desktop/src/pages/professional-create-page.tsx；professional-create-page.test.tsx；packages/story-core/src/story-fact.ts 及用例测试 | 旧流程把整栏人物、关系、世界粗映射为单条记录，未拆分地点和约束；通用作者草稿来源也无法关联原项目种子的字段与修订。初版修复测试又人为加入“地点：”标签，遗漏报告原始无标签输入。 | 分类与来源回归先稳定失败；补入原始“望潮崖、浓雾海”后，专业创建 17 项中 1 项失败。未知结构草稿权限红测在领域与浏览器存储层各失败 1 项。 | 人物、身份、关系、地点、世界背景和写作约束全部进入待确认。无标签内容仅在 2–8 个短中文名称均具有可靠地点后缀时拆为地点，混合或不确定输入保留世界背景，不猜测。来源保留项目种子、修订、旅程、字段、原始输入和句段。纯文本编辑只对白名单中的两种来源元数据结构开放。专业创建 17/17，故事事实持久化相关 37/37。 |
| F5 部分输出与调用账本口径不一致 | P2 中 | 隔离结果保存 267 个可见字符并提示结尾未完成，但调用账本显示没有取得输出。现场调用记录原件和供应商响应未取得。 | apps/desktop/src/infrastructure/model-hub-execution-service.ts；usage-center-service.ts；apps/desktop/src/pages/usage-center-page.tsx 及对应测试 | 流式增量只在上层提供回调时计数；账本没有结合不完整隔离结果和可见字符数。另有两处投影错误：已确认并预留但未发送被误称“确认前取消”，无用量关联的独立续写调用又被按任务名整体排除。 | 首轮 3 项稳定失败、60 项跳过；后续取消阶段与孤立续写红测 17 项中 4 失败、13 通过。 | 执行层始终计数可见 Unicode 字符；账本区分无输出失败、部分输出、完整结果、结果待核对、发送前安全终止和发送后取消。确认前离开保持零调用；已确认但未发送显示发送 0 次，发送后取消显示发送 1 次。续写仅按持久关联去重，旧或孤立调用不消失。首轮完整文件 63/63，后续修复 17/17。 |
| F6 大段设定文本不能拆分分类 | P2 中 | 约 129 字多主题文本可能整段保存为一条规则；另一段文本只进入手动表单。现场输入截图和数据库未取得。 | apps/desktop/src/infrastructure/story-settings-authoring.ts；apps/desktop/src/components/story-settings-tools.tsx；packages/data/src/author-recovery-sqlite-store.ts；apps/desktop/src/pages/story-governance-page.tsx 及测试 | 旧实现只有单句解析和手动兜底，没有本地批量拆分器、逐条审阅状态或可随数据库备份恢复的持久化闭环。 | 本地批量拆分与逐条审阅先稳定失败；新增 SQLite 仓储测试最初因模块不存在而失败。 | 单一“批量整理设定”入口按句段生成待确认草稿，每条保留原文和准确文字范围，可编辑、选类型、放弃或保存；未知项必须由作者分类，远程调用为零。未完成批次由 0082 SQLite 表保存、使用修订号并发保护，坏记录原样保留；提交后异常和重启先对账、只补未保存项。数据聚焦 54/54，设定页与解析聚焦 58/58。 |
| F7 恢复版本后续写插入章节开头 | P1 最高 | 约 58 字旧版本恢复后生成续写，摘要称候选锚点为 0，正确值应为 58；接受后新内容出现在开头。现场数据库和截图未取得。 | apps/desktop/src/pages/editor-page.tsx；editor-candidate-route.test.tsx；apps/desktop/src/infrastructure/runtime.ts | 整篇版本恢复完成后，页面把恢复前旧选区按新正文长度归一化，旧起点常为 0；下一次专业续写计划直接沿用该选区，运行时忠实保存了错误锚点。 | “恢复旧版本→生成→接受”用例修复前稳定失败；默认锚点不是恢复后稳定正文末尾。 | 恢复成功后默认选区和下一次续写锚点重置到稳定正文末尾；恢复后作者主动移动光标仍优先采用新位置。提示位置、接受后顺序、已接受状态、来源建议标识、基础版本、版本数量和旧快照不变均有断言。聚焦 2 项通过、72 项跳过。 |
| F8 连续长续写重复已有正文 | P2 高 | 约 6,514 字建议的前约 2,970 字与当前约 3,028 字正文高度重合；旧质量检查没有阻止接受。原始供应商输出未取得。 | packages/ai-core/src/quality-gate.ts；packages/application/src/use-cases/candidate-merge-planner.ts；candidate-use-cases.ts；apps/desktop/src/pages/editor-page.tsx；candidate-decision.css 及测试 | 质量门禁只检查建议自身的句子重复，接受规划只处理锚点和版本冲突，没有将隔离原文与其基础稳定正文做确定性前缀重合比较。 | 核心质量门禁新增用例后 3 失败、6 通过；应用合并规划新增用例后 2 失败、16 通过。 | 本机比较完全前缀和高相似长前缀；供应商原文保持不变。完全逐字前缀可由作者明确选择移除后使用；近似重合只显示证据并要求一次明确确认，不自动裁剪；普通短句不误报。核心质量门禁 9/9、合并规划 18/18、页面聚焦 2 通过/74 跳过。 |
| F9 导入人物显示为“旧结构化设定” | P2 低 | 规范导入的人物快照含姓名、角色和特质，但列表和编辑表单使用占位内容。现场导入文件和数据库未取得。 | apps/desktop/src/pages/story-governance-page.tsx；story-governance-page.test.tsx | 正式记录投影只读取少数通用字段；人物的姓名、别名、角色、特质和已知信息无法显示，编辑又会整对象替换而丢未知扩展字段。 | 新增“读取旧结构化人物并在编辑后保留扩展字段”用例；修复前标题和表单只能得到兼容占位。 | 人物投影读取 name/title/canonicalName、aliases、role、traits、description/shortDescription 和 knownInformation；编辑时合并原对象，未知扩展字段保持不变；不可识别旧形状继续显示安全提示。设定页 38/38。 |
| F10 向量模型能力验证走错接口 | P2 高 | text-embedding-v4 被固定聊天探针发送到聊天生成端点并返回 404。真实 Qwen 响应和凭据未取得。 | apps/desktop/src/infrastructure/model-hub-capability-probe-kind.ts；model-hub-embedding-capability-probe.ts；model-hub-embedding-service.ts；native-embedding-gateway.ts；apps/desktop/src-tauri/src/model_gateway/gateway.rs、types.rs；native_sqlite.rs；apps/desktop/src/pages/settings-page.tsx 及测试 | 模型中心只有硬编码文字生成的固定探针，没有按目录能力、任务分工或明确选择分流，也缺少向量条目数量、维度和有限数值验证。进一步审查又发现，网页层曾在原生端点、凭据、请求和隐私预检之前把向量调用标成已发送，导致真实零网络失败也可能显示一次发送。 | 新探针类型与向量探针测试起初因模块不存在而失败；原生发送边界审查新增的三个文件最初 53 项中有 4 项稳定失败，分别证明探针未传递同一账本、普通向量预检被提前记账、发送后中断未进入待核对，以及原生回执未回传网页层。 | 文本能力继续走生成端点；向量能力使用固定无隐私文本走向量端点，验证条目数、非空维度和每个有限数值；能力不明确时零发送。生产向量请求现携带同一调用标识和无正文账本，端点、凭据、请求、隐私及调度租约预检完成后，原生层在首次网络请求前原子写入发送回执；预检失败保持零发送，回执后超时或断开进入“结果需要核对”，每次最多一次发送、零自动重试，账本不保存探针文本或向量。三个网页层发送边界文件最终 55/55，新增原生回执聚焦 2/2、严格身份和作用域聚焦 1/1；原生格式、严格静态检查和完整测试通过。真实 Qwen 未执行。 |
| F11 错误提示与真实原因脱节 | P3 | 页面泛化提示检查连接或目录，不能解释向量模型误走聊天端点。现场支持编号、诊断和供应商响应未取得。 | apps/desktop/src/infrastructure/model-hub-capability-failure-presentation.ts；model-hub-capability-failure-presentation.test.ts；apps/desktop/src/pages/settings-page.tsx | 普通页面只按准备、发送、结果三段使用通用错误归一化，无法准确区分模型、路径、凭据、工作空间、目录、网络和超时。 | 专用错误呈现模块红测最初因模块不存在而失败。 | 能力失败按准确阶段显示自然中文原因、支持编号和恢复动作；模型不存在、路径不匹配、凭据、工作空间、目录、网络和超时分别投影。HTTP 状态与内部编号只在默认收起的高级诊断中。模型中心十个聚焦文件 155/155。 |
| F12 目录来源文案与事实不符 | P3 | 页面把数据库中手动来源的单个模型写成“从端点读取”。现场数据库未取得。 | apps/desktop/src/infrastructure/model-hub-catalog-presentation.ts；model-hub-catalog-presentation.test.ts；apps/desktop/src/pages/settings-page.tsx | 页面根据最近动作或模型数量推断目录来源，而没有只读取持久化的目录来源和最近同步时间。 | 新增来源投影测试，覆盖预设、手动、本地缓存和端点同步；修复前模块不存在。 | 页面严格依据持久化来源显示“预设”“手动添加”“本地缓存”或“从服务商读取”，并覆盖重启恢复。相关单元测试包含在模型中心 31/31 聚焦结果中，Qwen 页面聚焦 2/2 通过、65 跳过。 |
| U1 导入与导出抽屉溢出 | 界面验收，报告未单列 P 级 | 窄宽度或高缩放时标题、内容和右侧按钮被裁切并水平溢出。原始截图未取得。 | apps/desktop/src/components/data-transfer-panel.tsx；apps/desktop/src/styles.css；apps/desktop/src/data-transfer-layout-css-contract.test.ts | 标题与操作行禁止换行，子项缺少最小宽度归零；窄窗仍保留多列布局和横向按钮排列。 | 新布局合同修复前 2 项失败。 | 标题可换行，文字允许安全断行；64rem 以下单列，44.9375rem 以下操作纵向铺满，不以隐藏滚动条掩盖问题。布局合同 2/2 通过；真人视觉和系统级 200% 缩放未执行。 |
| U2 模型中心内部标签导致导航高亮错误 | 界面验收，报告未单列 P 级 | 切换创作任务安排、模型评测或图片生成后，侧栏和标题错误归到“设置”。原始截图未取得。 | apps/desktop/src/components/desktop-shell.tsx；desktop-shell.test.tsx | 壳层只把设置地址中的 model-center 哈希识别为模型中心，遗漏 model-routing、model-evaluation 和 image-generation。 | 参数化导航测试覆盖四个模型中心哈希；修复前后三个内部哈希失败。 | 四个哈希统一映射到“模型中心”标题和侧栏高亮，设置不再误亮。桌面壳目标套件 68/68。 |
| U3 设定类型错误提示位置错误 | 界面验收，报告未单列 P 级 | 无法判断类型时提示远离输入，焦点停在整理按钮。原始截图未取得。 | apps/desktop/src/components/story-settings-tools.tsx；apps/desktop/src/pages/story-governance-page.test.tsx | 手动分类提示在表单字段和按钮之后独立渲染，没有输入错误语义、描述关系或回焦逻辑。 | 聚焦用例新增回焦、错误状态、描述关联和同字段容器断言后，修复前 1 失败、36 跳过；实际焦点仍在整理按钮。 | 提示成为原输入字段的就地错误，自动建立无障碍描述和错误状态；结果渲染后一帧回焦原文本框，语义按钮继续支持鼠标、键盘和触摸。修复后 1 通过、36 跳过。真人触摸未执行。 |
| U4 未完成创作卡片布局不一致 | 界面验收，报告未单列 P 级 | 未完成作品的继续按钮位于内容区，普通作品操作位于卡片底部。原始截图未取得。 | apps/desktop/src/pages/projects-page.tsx；projects-page.test.tsx；apps/desktop/src/styles.css | 未完成旅程分支在 CardContent 内直接渲染操作链接，绕过统一 CardFooter。 | 聚焦布局用例修复前 1 项失败。 | 状态说明保留在内容区，“继续未完成创作”进入统一底部操作区且不会同时显示普通“打开”。聚焦 1 通过、17 跳过。 |
| U5 项目和章节名称缺少验证 | 界面验收，报告未单列 P 级 | 纯空白名称可形成无名记录；约 120 字名称没有统一显示边界。旧长名称必须继续可读。现场数据库未取得。 | packages/domain/src/entities/project.ts、chapter.ts 及测试；apps/desktop/src/pages/projects-page.tsx、workspace-page.tsx、app.test.tsx；apps/desktop/src/styles.css；legacy-name-layout-css-contract.test.ts | 新写入与旧快照恢复共用同一长度规范；直接收紧会让旧长名称无法打开。页面又用禁用按钮拦截空白输入，无法展示就地错误和回焦。 | 领域回归 2 项修复前失败；界面空名称和旧长名布局合同分别补充失败用例。 | 新建/重命名项目限制 1–120 字，章节限制 1–200 字；空白提交就地提示并回焦。旧值读取使用独立 10,000 字安全上限，不截断历史；列表以三行夹断和完整 title 保持可读。领域聚焦 2 通过/20 跳过、领域包 25/25；界面 2 通过/28 跳过；布局合同 1/1。 |
| U6 正文编辑器细节 | 界面验收，报告未单列 P 级 | “本次参考”和数量间距需保持；多步骤任务图行距过密。原始截图未取得。 | apps/desktop/src/pages/editor-page.tsx；apps/desktop/src/components/consistency-investigation-panel.tsx；apps/desktop/src/styles.css；consistency-investigation-layout-css-contract.test.ts | 多步骤任务图复用了紧凑历史列表样式，没有专用纵向间距和行高；参考数量文案需要防回归。 | 任务图布局合同修复前 1 项失败；参考文案已有源码和测试保护。 | 任务图使用专用类、较大项间距和 1.65 行高；参考文案保持自然空格。布局合同 1/1；真人视觉未执行。 |
| U7 设定页顶部说明过密 | 界面验收，报告未单列 P 级 | “逐章云端识别暂不可用”的长说明始终展开。原始截图未取得。 | apps/desktop/src/pages/story-governance-page.tsx；story-governance-page.test.tsx | 停用说明以常驻长警告整体渲染，没有摘要层和可访问披露状态。 | 新增折叠、aria-expanded、aria-controls、键盘操作和焦点保持断言；修复前缺少披露按钮。 | 页面常驻简短摘要，详细原因由“查看停用原因”按钮展开；Enter/空格均可切换，按钮保持焦点。设定页 38/38；真人视觉和真机触摸未执行。 |
| U8 失败连接没有“编辑并重试” | P2 高 | 失败连接锁住模型和验证操作，只能退役并清除凭据。现场凭据库和页面截图未取得。 | apps/desktop/src/pages/settings-page.tsx；settings-page.test.tsx；model-hub-store.ts | 失败活动连接缺少独立编辑流程；旧页面保存又可能读取最新修订号，绕过比较交换覆盖权威新配置。 | 回归覆盖参数修改、凭据保留、更换凭据、修订冲突、重试成功与失败。 | 失败活动连接提供“编辑并重试”；普通参数修改复用系统凭据，只有明确更换或退役才改变凭据。提交使用页面加载时的修订号，陈旧页面保存失败关闭。退役与编辑完全分离。 |
| U9 退役连接与当前连接混合显示 | P2 中 | 软删除历史仍出现在活动下拉，新建同供应商连接后旧退役横幅常驻。现场数据库和截图未取得。 | apps/desktop/src/pages/settings-page.tsx；model-hub-page-hydration.ts；model-hub-store.ts 及测试 | 活动与退役投影边界不统一；凭据清理失败又只有易被迟到结果覆盖的状态标记，陈旧目录还能被写回任务路线。 | 退役待清理红测 36 项中 2 失败；陈旧路由红测 20 项中 1 失败。 | 活动列表只含启用连接，退役历史单独折叠。清理未完成连接成为冻结态，普通保存、连接检查、目录同步、能力结果和提交均不能覆盖；显式退役可继续清理。显式与自动路线均原子校验目录可用且所属连接启用。重启恢复与同供应商重建均有回归，相关 3 文件 40/40。 |
| U10 缺少手动读取模型列表 | P2 中 | Qwen 活动连接模型下拉为空，只能手填；注册表将其配置为不自动读取且没有目录路径。真实目录响应未取得。 | apps/desktop/src/infrastructure/model-hub-provider-registry.ts；model-hub-provider-registry.test.ts；apps/desktop/src/pages/settings-page.tsx；settings-page.test.tsx | Qwen 注册为预设加手动策略，目录路径为空；页面没有用户主动同步动作，也没有失败后保留手动条目的持久状态。 | 新增 Qwen 目录端点和页面主动同步用例；修复前没有按钮和路径。 | 活动连接可由用户点击“重新读取模型列表”，调用目录端点；成功保存真实来源与时间，失败保存同步失败状态并保留手动模型，不触发能力验证。页面聚焦 2/2 通过、65 跳过；真实 Qwen 未执行。 |
| V1 选区操作人工边界 | 人工边界，报告未单列 P 级 | 自动化工具不能可靠模拟真人鼠标拖选，不能据此判定产品失败。真人鼠标记录未取得。 | apps/desktop/src/pages/editor-page.tsx；apps/desktop/src/infrastructure/editor-view-state-store.ts 及测试；editor-workspace-simplification.test.tsx | 当前选区锚点使用文本框 UTF-16 起止位置，不使用屏幕坐标；滚动位置与排版独立保存。缺口是人工拖选与真实系统缩放，而不是已证实的代码故障。 | 不制造产品失败红测；补查现有持久化、范围夹紧、选区动作和滚动键盘合同。 | 自动化确认只保存非正文视图数据，恢复时按当前正文长度夹紧选区，并保持 scrollTop 与排版边界。相关 3 个文件运行 80 通过、12 跳过。真人鼠标拖选、真人视觉和系统级 200% 缩放未执行。 |
| V2 设置快速跳转偶尔不滚动 | 人工边界，报告未单列 P 级 | 目标已在页面结构中，但视口偶尔未滚动。现场录像未取得。 | apps/desktop/src/pages/settings-page.tsx；settings-page.test.tsx | 目标可能晚于地址变化挂载；一次性定位会丢失。重复点击当前哈希又不会触发路由变化。 | 现有回归覆盖目标渲染后定位、直接地址、直接写作模式、诊断区和同一链接重复点击。 | 地址变化后以 0/50/100/200/400 毫秒有限重试等待目标，导航变化会取消旧任务；定位后滚动并聚焦。活动链接重复点击直接重跑定位。聚焦 5 通过、62 跳过；系统级 200% 缩放未执行。 |

## 三、当前聚焦命令与结果

以下结果来自当前共享工作树的分项执行，测试集合可能重叠，不能相加为全仓总数。

1. F5 修复前：

       pnpm --filter @inkshadow/desktop exec vitest run src/infrastructure/model-hub-execution-service.test.ts src/infrastructure/usage-center-service.test.ts src/pages/usage-center-page.test.tsx -t "keeps the observed visible character count|distinguishes no output|shows five truthful result outcomes" --reporter=verbose

   3 个文件失败；3 项失败、60 项跳过。

2. F5 修复后，同一命令：3 个文件通过；3 项通过、60 项跳过。

3. F5 相关完整文件：

       pnpm --filter @inkshadow/desktop exec vitest run src/infrastructure/model-hub-execution-service.test.ts src/infrastructure/usage-center-service.test.ts src/pages/usage-center-page.test.tsx --reporter=verbose

   3 个文件通过；63 项通过、0 项失败、0 项跳过。

4. F7：

       pnpm --filter @inkshadow/desktop exec vitest run src/pages/editor-candidate-route.test.tsx -t "anchors a professional continuation|uses an author-selected continuation" --reporter=verbose

   1 个文件通过；2 项通过、72 项跳过。

5. F8 核心质量门禁：修复前 3 项失败、6 项通过；修复后 9/9 通过。应用合并规划修复前 2 项失败、16 项通过；修复后 18/18 通过。页面聚焦 2 项通过、74 项跳过。准确命令由最终测试汇总统一登记。

6. U3 修复前：

       pnpm --filter @inkshadow/desktop exec vitest run src/pages/story-governance-page.test.tsx -t "hands an unparsed sentence" --reporter=verbose

   1 个文件失败；1 项失败、36 项跳过。修复后同一命令为 1 个文件通过；1 项通过、36 项跳过。

7. V2：

       pnpm --filter @inkshadow/desktop exec vitest run src/pages/settings-page.test.tsx -t "keeps focus on the requested settings section|runs the active quick jump again|restores the import and export section from a direct deep link|opens the real diagnostics section from a direct writing mode deep link" --reporter=verbose

   1 个文件通过；5 项通过、62 项跳过。

8. V1 自动化边界：

       pnpm --filter @inkshadow/desktop exec vitest run src/infrastructure/editor-view-state-store.test.ts src/pages/editor-workspace-simplification.test.tsx src/pages/editor-candidate-route.test.tsx -t "persists only noncontent view metadata|selection|scroll|zoom|page scroll" --reporter=verbose

   3 个文件通过；80 项通过、12 项跳过。

9. F10/F12 模型中心分流、向量响应与目录来源的四个聚焦文件：31/31 通过。U10 页面聚焦：2 项通过、65 项跳过。真实供应商调用未执行。

10. F11 的分阶段中文错误、支持编号和恢复动作已经接入生产页面；U8 的“编辑并重试”、凭据保留和修订号比较交换已经接入；U9 的活动／退役分区、清理待完成冻结态及路线所有者校验已经接入。U9 相关三个文件为 40/40；F11 与 U8 的既有聚焦结果保持有效。原生向量发送边界的三个网页层文件最终为 55/55，新增原生回执聚焦 2/2、严格身份和作用域聚焦 1/1；最终原生格式、严格静态检查和完整测试均通过。

## 四、数据、版本与发布事实

- 本轮新增 `0082_author_recovery_records.sql`（Tauri 85），用于保存作者未完成的批量设定审阅。生产桌面端使用同一 SQLite 权威执行器；写入和删除使用修订号比较交换，坏记录和未来结构版本原样保留。
- 新表已进入全新建库、v0.2.3 连续升级、备份、恢复、旧备份兼容和原生迁移清单；备份恢复逐字核对原始 JSON、修订号和时间戳。
- 未修改任何已发布迁移或校验值，0079、0080、0081 字节保持不变。
- 未清空数据库，未删除作品、版本、用户设定、失败调用或历史隔离结果。
- 应用版本未修改。
- 本轮未创建、移动或删除任何标签；现有 `v0.2.14` 及更早标签保持原指向。
- 本轮未创建或修改 GitHub Release，也未移动或覆盖既有发布附件。
- 最终提交 SHA、远端 `main` SHA 和推送后核对结果不在提交自身中预填，由最终交付报告绑定；本文件不使用循环自引用的占位指纹。

## 五、当前完整门禁

1. `pnpm test`：全仓 4,037 项通过、0 项失败、65 项跳过；其中桌面端 2,634 项通过、0 项失败、1 项跳过，数据层 483/483。
2. `pnpm typecheck`：有类型脚本的 20 个工作区全部通过；`pnpm lint`、`pnpm format:check`、`git diff --check` 均通过。
3. `pnpm check:secrets`、`pnpm check:licenses`、`pnpm check:boundaries`、`pnpm check:desktop-release`、`pnpm test:scripts` 全部通过；许可证 137 项、包边界 20 个、脚本测试 40/40。
4. `pnpm build`：有构建脚本的 20 个工作区全部通过；桌面正式网页构建处理 2,311 个模块并合并为 25 个块，网页端和其余工作区构建通过。
5. 正式前端旧总体积上限首次按设计失败：7,400,574 / 7,340,032 字节。隔离构建的发布基线实体大小为 7,337,824 字节，当前实体大小为 7,400,736 字节，增长 62,912 字节；审计未发现重复运行时、源码映射或测试模块。经用户明确授权，只把总预算提高 128 KiB 至 7,471,104 字节，当前计入预算 7,400,574 字节，余量 70,530 字节；入口、异步块、样式、工作线程和一般资源的单项上限全部保持不变。
6. `pnpm check:rust`：Rust 格式和 `clippy -D warnings` 通过；库测试 210 项通过、0 项失败、1 项按约定忽略，主程序和文档测试均无失败。
7. `pnpm test:e2e`：正式网页端到端 26/26，通过 1440、1280、1024、800 宽度及浏览器等效 200% 缩放、双像素密度、明暗主题、鼠标／键盘／触摸激活合同、快速路由、候选隔离、导入导出和诊断旅程。
8. `pnpm test:e2e:release` 在提交前按设计拒绝脏工作区；第一次干净提交复跑又准确发现发布清单检查器仍保留旧 7 MiB 总预算，并在 7,400,736 / 7,340,032 字节处于旅程开始前失败。新增预算一致性回归先 0/1、修复后 1/1，完整脚本测试增至 40/40；最终干净提交必须重新执行发布态端到端，结果与提交 SHA、远端 `main` 一致性由最终交付报告记录。
9. 正文、不可变版本、项目种子、用户设定、恢复批次和历史隔离结果的回归均验证保持或原子演进；本轮没有删除或改写现场数据。

## 六、未取得与未执行

- 现场数据库、原始截图与录像、完整诊断包、应用和组件调用栈、支持编号、供应商原始响应：**未取得**。
- 真实阿里云百炼/Qwen、真实 DeepSeek、其他真实付费模型调用：**未执行**。
- 真实安装程序、现场数据库恢复、真实断网和供应商迟到响应：**未执行**。
- 真人鼠标拖选、真实触摸、真人视觉检查、操作系统级 200% 缩放：**未执行**。
- 本轮安装包、标签、GitHub Release：不在任务范围内，**未执行**。

## 七、剩余风险

1. 真实向量供应商的端点、工作空间参数、目录权限、迟到结果和错误载荷尚未验证；可控本地网关与原生测试只证明本地路由、单次发送、原子回执和失败关闭合同。
2. 布局合同和浏览器自动化不能替代真实 Windows 字体、真人触摸、真人拖选和操作系统级 200% 缩放。
3. 没有现场数据库，不能证明报告中的具体旧记录已在原机恢复；当前结论绑定构造数据和当前源码。
4. 干净提交上的发布态端到端、远端 `main` 推送和回读核对仍须在提交形成后执行；未取得结果前不得写成通过。
