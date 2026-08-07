# 墨影 InkShadow

本地优先、隐私优先的 AI 长篇内容创作工作台。

InkShadow 是一个本地优先、隐私优先、面向长篇小说创作的 AI 工作台。用户可以从一句
灵感或一篇已有小说开始；AI 通过可追溯、可撤销的建议版本协助开书、续写、改写和检查，
人物、世界、事件与长期记忆仍由用户掌握最终决定权。Windows 桌面端无需注册即可创作，
项目正文默认保存在本机；云同步和远程模型能力必须由用户主动配置。

> 当前版本为工程预览版。GitHub Release 中的 Windows 安装包尚未进行
> Authenticode 商业签名，不应直接用于正式生产或敏感数据环境。

当前源码版本为 `0.2.0`。代码已完成新手三入口、导入试改、四区写作工作台、Model Hub、
统一故事事实、因果关系、分层上下文和证据化检查的阶段性重构。它仍是工程预览：只有真正
接通、具备能力证据且通过本地检查的模型功能才会显示为可用；缺少模型、证据或配置时会明确
跳过，不以占位结果冒充成功。

## 主要能力

- 首页三个任务入口：从一句想法开始、导入已有小说、专业创建
- 正文、规划、设定、检查四区工作台，以及可折叠章节栏和 AI 创作助手
- 跟随系统、浅色和深色三种外观；独立设置页与启动页支持完整滚动
- 本地项目、章节、大纲、素材和统一故事事实管理
- 自动保存、崩溃草稿恢复、版本记录、回收站和备份恢复
- AI 结果候选隔离：用户确认前不会覆盖正式正文
- InkShadow Model Hub：OpenAI、DeepSeek、阿里云百炼、火山方舟、Gemini、Claude、Ollama 与自定义 OpenAI-compatible 连接预设
- 连接测试、模型发现、能力证据、22 类小说任务分工、主备回退，以及质量/经济/本地隐私方案
- 自定义兼容接口支持受限路径、单一安全认证 Header、请求超时和只读发现重试；密钥值仍只进入系统凭据库
- 正式事实与未确认事实隔离、连续章节状态提取、可验证因果事件图、分层上下文编译、语义检索、本地或百炼 Qwen 重排和 Token 取舍记录
- 可追溯的章节摘要、上下文历史与 AI 剧情规划建议；自动更新与重大事实确认遵循不同安全等级
- 带原文证据的确定性矛盾、世界规则、人物知识、视角、人物声纹、多线叙事、伏笔和节奏检查
- 基于确定性影响范围的沙盒剧情试演；结果不会改动主线正文或正式设定
- 可见、可编辑、可暂停和可清空的写作偏好学习，不形成隐藏长期偏好
- TXT、Markdown、DOCX、EPUB、静态 HTML 和可提取文本 PDF 的安全导入
- Bundle、Markdown、TXT、结构化报告、DOCX 和 PDF 导出
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

## 数据与隐私原则

- 首次使用不强制登录。
- 本地项目默认不上传，云同步默认关闭。
- API 密钥写入系统凭据库，不写入项目数据库。
- AI 输出先进入候选层，确认前不覆盖正式内容。
- 日志和诊断包不得包含密钥、完整 Prompt 或正文。
- 订阅状态不会锁定本地读取、编辑、备份和导出。

## 下载

内部预览安装包发布在 [GitHub Releases](../../releases)，并标记为 Pre-release。

安装包未签名时，Windows 可能显示“未知发布者”提示。正式分发前仍需完成代码签名、
时间戳、隔离安装/升级/卸载测试以及法律和安全审批。当前预览不应承载敏感数据或唯一副本。

## 许可证

Copyright © 2026 InkShadow. All rights reserved.

本仓库为专有商业软件源码，`package.json` 标记为 `UNLICENSED`。查看本仓库不代表获得
复制、修改、再分发、托管或商业使用授权。
