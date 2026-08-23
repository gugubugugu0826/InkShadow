# 墨影 InkShadow

本地优先、隐私优先的 AI 长篇内容创作工作台。

InkShadow 是一个本地优先、隐私优先、面向长篇小说创作的 AI 工作台。用户可以从一句
灵感或一篇已有小说开始；AI 通过可追溯、可撤销的建议版本协助开书、续写、改写和检查，
人物、世界、事件与长期记忆仍由用户掌握最终决定权。Windows 桌面端无需注册即可创作，
项目正文默认保存在本机；云同步和远程模型能力必须由用户主动配置。

> 当前版本为工程预览版。GitHub Release 中的 Windows 安装包尚未进行
> Authenticode 商业签名，不应直接用于正式生产或敏感数据环境。

> [!WARNING]
> **v0.2.3 发布后安全公告：**已发布提交
> `3abdcfeb327567c632e440d55d11f0af6f4911d2` 的真实 Windows 11 Tauri/Wry +
> DeepSeek `deepseek-v4-flash` 测试发现：Candidate 正确接受并创建版本后，又隐式触发
> `long_memory_compression`，把已接受正文发送到 Provider。测试随即按安全停止条件终止。
> 因此不建议使用已发布 `v0.2.3` 通过真实 Provider 处理敏感正文。已发布 `v0.2.4` 标签基线与
> 已发布 `v0.2.5` 均已纳入代码修复和自动化覆盖；但 v0.2.5 的真实 Provider、Windows
> Tauri/Wry、Credential Manager、系统 200% DPI 与外部应用打开仍为 **`BLOCKED_EXTERNAL`**，
> 不得把源码或 Chromium 测试写成真实安装版复测。

当前桌面应用清单版本为 `0.2.9`。指定的 `v0.2.8` 人工复测安装包及其来源清单继续保留在
本地，不覆盖任何公开附件。截至 `0.2.9` 候选准备时，最新不可变公开工程预览版仍为
[`v0.2.7`](https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.7)；`0.2.9` 是否已经发布
以 [GitHub Releases](https://github.com/gugubugugu0826/InkShadow/releases) 的实际页面为准，
候选准备本身不等于发布完成。所有已经发布的标签和附件均不得移动或静默替换。
代码已完成新手三入口、导入试改、四区写作工作台、Model Hub、
统一故事事实、因果关系、分层上下文和证据化检查的阶段性重构。它仍是工程预览：只有真正
接通、具备能力证据且通过本地检查的模型功能才会显示为可用；缺少模型、证据或配置时会明确
跳过，不以占位结果冒充成功。

## 历史版本：v0.2.5 已发布 Pre-release 重点

- 接受 Candidate 只保存正式正文、创建新的不可变版本并更新纯本地可重建状态；接受、保存、恢复和历史回填的默认后台链精确产生 0 次 Provider 调用。
- 删除凭据后可重新绑定原连接；退役连接继续保留历史审计，但不进入 ready、推荐或普通路由，同供应商重新配置不再要求手工修改内部 ID。
- 顶栏、作品库、Model Hub、任务推荐和实际生成共享同一权威 readiness；当前章节的隐私、上下文和请求预检失败时不会创建 invocation、Candidate 或费用记录。
- 一批开头建议明确对应 3 次独立 Provider 调用；稳定槽位分别记录成功、失败、取消、未发送或结果不明确，重启只结清状态而不自动重发。
- 新安装默认直接模式，既有用户保留原写作方式并可随时切换；首次启用只授权确定性本地整理，不授权额外联网或自动接受正文。第一次真实续写会另行披露发送范围、精确连接/模型、1 次调用、0 次重试、费用和隐私边界，重要条件变化时 0 dispatch 并重新确认。
- 两种模式的生成都先保留为隔离 Candidate；只有作者明确选择“使用这版”后，直接模式才对此次新增 delta 在本机整理普通设定，并只提示“已整理 N 条”；重大设定仍进入作者确认，整理过程为 0 次 Provider 调用。
- 检查页提供受控的长篇一致性调查：固定只读工具、确认后最多 1 次模型调用、0 次自动重试；取消、崩溃或结果不明确不会静默重发，也不会直接修改正文。
- StoryMemory/Narrative State、多粒度范围化 FTS、有界 4×80 查询、只读 TaskGraph 与独立修复 Candidate 已接线；自动多模型 fallback、确认后动态 replanning 和云端 Agent 保持关闭。绑定来源提交的 5k/20k/50k/200k production-path benchmark 共 48 个样本，原始 JSON 为 371,204 bytes、SHA-256 `7b8eef0ed8bd544f23e7efabe74ad09ff187013404730cbec43c7c42d84ec1c5`；它使用确定性 fixture 与 counted fake gateway，真实 Provider 调用为 0，不能外推真实模型质量。
- Markdown、DOCX、EPUB 和 PDF 已能真实嵌入经安全校验的项目图片；Tauri 保存只在一次性票据、原子写入和磁盘回读 size+SHA 验证成功后返回路径/字节/状态回执。真实 Tauri 对话框和四个外部应用打开仍待第二阶段验证。
- 200% 等效视口进入正文优先的单列/抽屉模式，并覆盖 Escape、焦点返回、44px 操作目标和页面无横向溢出。真实 Windows 系统 200% DPI 仍待复测。

来源提交的完整本地候选门禁、最终构建、安装包哈希与远端 CI 已通过并绑定到上述 Release；
真实 Provider 与 Windows Tauri 第二阶段复测仍未执行。Settings 两个固定、无作品内容的 probe
入口现已把点击时表单、精确目标和
content-free SHA-256 authority 绑定到同一 prepared input，并在生成前复核；漂移为 0 call，成功
精确 1 call。豆包 Endpoint ID 非空时作为唯一有效模型贯穿披露、保存和派发，避免确认 A 却发送 B；
设置页聚焦 55/55 PASS。完整边界见
[当前状态](docs/execution/CURRENT_STATUS.md) 与
[v0.2.5 中文发布说明](docs/execution/RELEASE_CHECKLIST.md#v025-已发布-pre-release-中文说明与追踪)。

## v0.2.3 已发布工程预览重点

- 修复 Model Hub 跨页面进入时的诊断身份和计时语义；系统凭据摘要读取设有 5 秒上限，超时会保留缓存目录并明确降级，不把停用或退役连接恢复为可用连接。
- 增加默认折叠的官方模型候选浏览器和 22 类小说任务推荐入口。官方候选只用于发现，不等于账户已接通、能力已验证或任务已路由；选择未连接模型只保存不含凭据的短期连接意图，不会调用模型或自动改写任务路由。
- 修复正文工作区右侧裁切；宽屏支持可由键盘调整的正文/助手分栏，1024px 及以下继续使用抽屉，并复核 1440、1280、1024、800 与 200% 等效视口。
- Novel Skill 仅完成本地 SQLite 与模拟生成的离线冒烟测试，全部实验 Skill 继续默认关闭；没有执行真实供应商请求、192 次付费 A/B 或 2,496 项人工评分。

`v0.2.3` 的历史发布说明与固定证据继续保留在
[持续发布门禁](docs/execution/RELEASE_CHECKLIST.md#v023-已发布-pre-release-中文说明与追踪)，不得用后续候选的自动化证据改写。

## 主要能力

- 首页三个任务入口：从一句想法开始、导入已有小说、专业创建
- 可恢复的一句话开书、创建前摘要和统一 ProjectSeed；第一章保持空白，AI 开头只作为待确认建议版本
- 开书先等待作者明确选择一个可用开头，再用确定性缺口规划一次生成最多 3 个问题；信息充分时可为 0–2 个。回答只更新已有问题和 ProjectSeed，不追加新问题，也不会触发第 4 次 AI planner 调用；作者可随时跳过、返回或结束
- 每批 AI 开头在事前披露后精确对应 3 个独立 Provider 调用；选择开头和回答引导问题均为 0 次 Provider 调用，不自动重试或追加 planner 请求
- 开书页可原位连接 DeepSeek、OpenAI、阿里云百炼/Qwen、火山方舟/豆包、Ollama、智谱 GLM 或自定义 OpenAI-compatible；能可靠列目录时自动发现模型，否则用不含作品内容的固定探针验证文本能力；失败可修改、重试、改选模型或跳过，不会覆盖旧 Key
- 正文、规划、设定、检查四区工作台，以及可折叠章节栏和 AI 创作助手
- 跟随系统、浅色和深色三种外观；独立设置页与启动页支持完整滚动
- 本地项目、章节、大纲、素材和统一故事事实管理
- 自动保存、崩溃草稿恢复、版本记录、回收站、每日 03:00 自动备份和手动备份恢复
- AI 结果候选隔离：用户确认前不会覆盖正式正文
- 可对选中的正文先生成独立改写建议，再按精确基线查看差异、接受、拒绝或重新生成；原文不会被静默覆盖
- 接受建议、接受导入改写、恢复历史版本或明确手动保存后，后台只登记并补跑本地搜索与因果/故事关联等可重建任务；摘要和连续故事状态的模型阶段被强制关闭，整条接受/保存/恢复后台链精确产生 0 次 Provider 调用，派生失败也不回滚正文
- 旧作品可先查看只读回填计划；计划明确显示 Provider 调用上限为 0，经确认后也只登记当前稳定章节版本缺失的本地整理任务，不追溯改写历史版本
- InkShadow Model Hub：OpenAI、DeepSeek、智谱 GLM、阿里云百炼、火山方舟、Gemini、Claude、Ollama 与自定义 OpenAI-compatible 连接预设
- 连接测试、模型发现、能力证据、22 类小说任务分工、主备回退，以及质量/经济/本地隐私方案
- 自定义兼容接口支持受限路径、单一安全认证 Header、请求超时和只读发现重试；密钥值仍只进入系统凭据库
- 正式事实与未确认事实隔离、连续章节状态与章节摘要的可审计底层合同、可验证因果事件图、分层上下文编译、本地范围化 FTS 和 Token 取舍记录；vector/远程重排只保留底层可选协议与历史诊断，普通搜索入口当前关闭。连续状态/摘要的直接云操作也停用，等待独立授权与派发恢复合同
- ProjectSeed 中只有作者确认的类型、人物、世界、规则和方向会进入续写上下文；未确认的 AI 推测不会被当作正式资料
- 可追溯的章节摘要、上下文历史与 AI 剧情规划建议；规划条目可逐项采纳并保留原简介，自动更新与重大事实确认遵循不同安全等级
- 带原文证据的确定性矛盾、世界规则、人物知识、视角、人物声纹、多线叙事、伏笔和节奏检查；页面逐类披露“已实际检查”或“证据不足未检查”，不会把缺资料显示为通过
- 检查结果绑定不可变章节版本并保存本地快照；处置前重新计算当前问题与完整证据，旧版本的相同问题不会沿用到新版本；问题可忽略、标记为允许或原子撤销，撤销同时校验项目、章节、版本、问题、证据与处置修订；人物别名冲突必须由作者选择已有对象或明确保留为新对象，结构异常时失败关闭
- POV 知识检查记录角色何时、通过哪个已确认事件和来源获得信息，来源不完整、未确认或已失效时不会冒充可靠证据
- 基于确定性影响范围的沙盒剧情试演；结果不会改动主线正文或正式设定
- 可见、可编辑、可暂停和可清空的写作偏好学习，不形成隐藏长期偏好；明确反馈与偏好同步原子提交，重复重试不会重复学习
- TXT、Markdown、DOCX、EPUB、静态 HTML 和可提取文本 PDF 的安全导入
- Bundle、Markdown、TXT、EPUB 3、结构化报告、DOCX 和 PDF 导出
- 章节可设为“仅本机”；只要作品仍保留任何仅本机章节，读取全书资料的 AI 操作就只能使用已验证的本地模型，并在发送前复核章节、版本和隐私状态；项目导出默认排除私密章节
- 经能力确认的 OpenAI-compatible 图片生成，可保存为新 PNG，不自动插入正文或覆盖已有文件
- 可选的证据约束多角色深度审稿；未确认事实和失效证据不会进入审稿上下文
- 可选的端到端加密同步、团队协作和审阅基础设施，需要自行部署 Cloud API，默认关闭
- 失败关闭的安全更新校验协议、诊断脱敏、权限边界和数据删除治理

当前 GitHub 预览不提供托管云服务，也尚未接入正式更新域名、发布签名链或自动更新通道。
真实供应商凭据的线上互操作、百万字规模性能、安装升级与恢复矩阵，以及 Windows 商业签名仍是
发布前需要在独立环境完成的验收边界。

## 技术栈

- Tauri 2 / Rust
- React 19 / TypeScript / Vite
- SQLite
- pnpm workspace
- Vitest / Playwright

## 运行预览安装包

- Windows 10 或 Windows 11（x64）
- Microsoft Edge WebView2 Runtime

## 源码构建环境

- Node.js 24+
- pnpm 11+
- Rust 1.85+
- Microsoft C++ Build Tools
- Microsoft Edge WebView2 Runtime

## 本地开发

```powershell
pnpm install --frozen-lockfile
pnpm dev:desktop
```

只启动浏览器前端预览：

```powershell
pnpm dev
```

浏览器预览不包含完整的 Tauri、系统凭据库和原生 SQLite 能力。

## 检查与测试

```powershell
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e:release

cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

`pnpm check` 覆盖 TypeScript、ESLint、单元测试、构建、许可证、密钥与架构边界检查；
Rust 检查和端到端测试需要按上面的独立命令执行。

生成未签名的 Windows NSIS 内部候选：

```powershell
$env:CI = "true"
pnpm release:candidate:unsigned
```

构建输出位于：

```text
apps/desktop/src-tauri/target/release/bundle/nsis/
```

## 仓库结构

```text
apps/
  desktop/     Windows 桌面应用
  web/         本地加密 Web Guest
  cloud-api/   云端 API
  android/     Android 边界 PoC
packages/      领域、数据、同步、AI、UI 等共享包
deploy/        部署清单
scripts/       构建、发布与安全检查
tests/         端到端测试
```

## 文档

- [产品重构与真实能力审计](docs/product-rebuild/README.md)
- [前端页面、内容与接口索引](docs/front-end/README.md)
- [桌面原生、共享包与云后端指引](docs/back-end/README.md)
- [当前状态、测试结果与开放问题](docs/execution/CURRENT_STATUS.md)
- [GitHub 上传与 Release 发布注意事项](docs/GITHUB_PUBLISH_RELEASE_GUIDE.md)

## 数据与隐私原则

- 首次使用不强制登录。
- 本地项目默认不上传，云同步默认关闭。
- API 密钥写入系统凭据库，不写入项目数据库。
- AI 输出先进入候选层，确认前不覆盖正式内容。
- 日志和诊断包不得包含密钥、完整 Prompt 或正文。
- 私密章节默认不发送给远程模型，也不会默认进入项目导出；读取全书资料的操作在项目仍保留私密章节时只允许已验证的本地模型。
- 订阅状态不会锁定本地读取、编辑、备份和导出。

## 下载

内部预览安装包发布在 [GitHub Releases](https://github.com/gugubugugu0826/InkShadow/releases)，并标记为 Pre-release。
[`v0.2.3`](https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.3) 已作为未签名工程预览发布，安装前请核对同一 Release 中的 `SHA256SUMS`。
[`v0.2.4`](https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.4) 已于 2026-08-14 公开为未签名 Pre-release；
[`v0.2.5`](https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.5) 已于 2026-08-20 公开为未签名 Pre-release，包含以下 3 个附件：

- `InkShadow_0.2.5_x64-setup.exe`：7,606,152 bytes；SHA-256 `f422467fa5fdff4236f3d453cb21de3927c89375e106ff372852f918079f20ad`
- `inkshadow-release-manifest.json`：11,717 bytes；SHA-256 `4dce031a71eaa1664dcc993bd4f68362fb3d97b7843110b5ebc0b7c45b0bed0c`
- `SHA256SUMS`：194 bytes；SHA-256 `0f4330efd42cd7d898497de2d0b6866fc2c9ba7b3533e8c11a233dd6a8439eec`

在对应 Release 正式公开并附带校验文件前，请勿从其他来源下载安装包。
所有已经发布的版本标签与公开附件均不可覆盖、不可移动；当前发布状态以 GitHub Releases 为准。

安装包未签名时，Windows 可能显示“未知发布者”提示。正式分发前仍需完成代码签名、
时间戳、隔离安装/升级/卸载测试以及法律和安全审批。当前预览不应承载敏感数据或唯一副本。

## 许可证

Copyright © 2026 InkShadow. All rights reserved.

本仓库为专有商业软件源码，`package.json` 标记为 `UNLICENSED`。查看本仓库不代表获得
复制、修改、再分发、托管或商业使用授权。
