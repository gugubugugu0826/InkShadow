# 墨影 InkShadow

本地优先、隐私优先的 AI 长篇内容创作工作台。

InkShadow 是一个本地优先、隐私优先、面向长篇小说创作的 AI 工作台。用户可以从一句
灵感或一篇已有小说开始；AI 通过可追溯、可撤销的建议版本协助开书、续写、改写和检查，
人物、世界、事件与长期记忆仍由用户掌握最终决定权。Windows 桌面端无需注册即可创作，
项目正文默认保存在本机；云同步和远程模型能力必须由用户主动配置。

> 当前版本为工程预览版。GitHub Release 中的 Windows 安装包尚未进行
> Authenticode 商业签名，不应直接用于正式生产或敏感数据环境。

当前源码与待发布补丁版本为 `0.2.1`。代码已完成新手三入口、导入试改、四区写作工作台、Model Hub、
统一故事事实、因果关系、分层上下文和证据化检查的阶段性重构。它仍是工程预览：只有真正
接通、具备能力证据且通过本地检查的模型功能才会显示为可用；缺少模型、证据或配置时会明确
跳过，不以占位结果冒充成功。

## 主要能力

- 首页三个任务入口：从一句想法开始、导入已有小说、专业创建
- 可恢复的一句话开书、创建前摘要和统一 ProjectSeed；第一章保持空白，AI 开头只作为待确认建议版本
- 开书引导初始规划 5 个重点，并可按作者回答有限扩展到最多 12 个不重复重点；页面显示第 N/M 问、完成百分比、剩余重点和扩展原因，作者可随时跳过、返回或结束，不存在“三问上限”或无限追问
- 开书页可原位连接 DeepSeek、OpenAI、阿里云百炼/Qwen、火山方舟/豆包、Ollama、智谱 GLM 或自定义 OpenAI-compatible；能可靠列目录时自动发现模型，否则用不含作品内容的固定探针验证文本能力；失败可修改、重试、改选模型或跳过，不会覆盖旧 Key
- 正文、规划、设定、检查四区工作台，以及可折叠章节栏和 AI 创作助手
- 跟随系统、浅色和深色三种外观；独立设置页与启动页支持完整滚动
- 本地项目、章节、大纲、素材和统一故事事实管理
- 自动保存、崩溃草稿恢复、版本记录、回收站、每日 03:00 自动备份和手动备份恢复
- AI 结果候选隔离：用户确认前不会覆盖正式正文
- 可对选中的正文先生成独立改写建议，再按精确基线查看差异、接受、拒绝或重新生成；原文不会被静默覆盖
- 接受建议、接受导入改写、恢复历史版本或明确手动保存后，后台安全更新搜索、摘要、故事变化与故事关联；失败可自动补跑或在任务中心立即重试，不回滚正文
- 旧作品可先查看只读回填计划和潜在模型调用上限，再经一次明确确认，为当前稳定章节版本登记缺失的后台整理任务；不会追溯改写历史版本
- InkShadow Model Hub：OpenAI、DeepSeek、智谱 GLM、阿里云百炼、火山方舟、Gemini、Claude、Ollama 与自定义 OpenAI-compatible 连接预设
- 连接测试、模型发现、能力证据、22 类小说任务分工、主备回退，以及质量/经济/本地隐私方案
- 自定义兼容接口支持受限路径、单一安全认证 Header、请求超时和只读发现重试；密钥值仍只进入系统凭据库
- 正式事实与未确认事实隔离、连续章节状态提取、可验证因果事件图、分层上下文编译、语义检索、本地或百炼 Qwen 重排和 Token 取舍记录
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

内部预览安装包发布在 [GitHub Releases](https://github.com/gugubugugu0826/InkShadow/releases)，并标记为 Pre-release。`v0.2.1` 仍在施工与发布门禁阶段，尚未生成干净候选或公开发布；现有 `v0.2.0` 仅是不可覆盖的历史预览。

安装包未签名时，Windows 可能显示“未知发布者”提示。正式分发前仍需完成代码签名、
时间戳、隔离安装/升级/卸载测试以及法律和安全审批。当前预览不应承载敏感数据或唯一副本。

## 许可证

Copyright © 2026 InkShadow. All rights reserved.

本仓库为专有商业软件源码，`package.json` 标记为 `UNLICENSED`。查看本仓库不代表获得
复制、修改、再分发、托管或商业使用授权。
