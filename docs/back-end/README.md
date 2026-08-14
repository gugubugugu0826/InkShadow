# InkShadow 非前端工程文档

> 文档状态：`SUPPORTING_CURRENT`  
> 基于源码复核：2026-08-14  
> Desktop 当前源码目标（App Version）：`0.2.4`；最近已发布版本：`0.2.3`；v0.2.4 安全修复候选尚未发布  
> 设计基线（Design Baseline）：`DESIGN v0.3.1b`  
> 文档性质：当前实现指引，不把计划代码描述成已部署能力

InkShadow 不是只有“前端”和“后端”两块。除用户界面外，仓库还包含：

1. Cloud API 服务端；
2. Tauri/Rust 桌面原生层；
3. 可被多个应用复用的领域、应用、数据和安全包；
4. Android 离线与 KeyStore POC；
5. 部署、备份、恢复、发布、检查和测试工具。

本目录以 `back-end` 作为便于查找的统一入口，但不会把共享领域包、Android 或工程脚本错误地
称为云后端。

DESIGN v0.3.1b 只约束目标界面与交互验收；它不会改变 Tauri、数据库或 Desktop 应用版本。
当前源码目标为 0.2.4，最近已发布工程预览安装包仍为 0.2.3。

## 文档导航与状态

| 状态                    | 文档                                                                                                     | 内容与边界                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `SUPPORTING_CURRENT`    | [`CLOUD_BACKEND.md`](CLOUD_BACKEND.md)                                                                   | Cloud API、PostgreSQL、HTTP、服务和后台任务；代码存在不表示生产 Cloud 已部署         |
| `SUPPORTING_CURRENT`    | [`DESKTOP_NATIVE.md`](DESKTOP_NATIVE.md)                                                                 | Tauri/Rust 可信边界、SQLite、凭据、模型网络、项目密钥和备份；当前迁移上限 Tauri `68` |
| `SUPPORTING_CURRENT`    | [`SHARED_PACKAGES.md`](SHARED_PACKAGES.md)                                                               | workspace 领域、应用、数据、导入导出和共享 UI 包；当前 Data 迁移上限 `0065`          |
| `SUPPORTING_CURRENT`    | [`ANDROID_OPERATIONS_TOOLING.md`](ANDROID_OPERATIONS_TOOLING.md)                                         | Android POC、部署模板、发布/安全脚本、CI 和 E2E；不属于当前默认创作主链路            |
| `AUTHORITATIVE_CURRENT` | [`../product-rebuild/02-DATA-REUSE-AND-MIGRATION.md`](../product-rebuild/02-DATA-REUSE-AND-MIGRATION.md) | 数据复用、前向迁移与回滚规则                                                         |

- [`../front-end/README.md`](../front-end/README.md)：用户页面、路由和前端接口。
- [`../GITHUB_PUBLISH_RELEASE_GUIDE.md`](../GITHUB_PUBLISH_RELEASE_GUIDE.md)：GitHub 上传与
  Release 流程。

## 一张表理解仓库

| 区域                     | 是否有页面 | 主要职责                                         | 主要入口                     |
| ------------------------ | ---------- | ------------------------------------------------ | ---------------------------- |
| `apps/desktop/src`       | 有         | Desktop React UI 和前端运行时接线                | `main.tsx`、`app.tsx`        |
| `apps/web/src`           | 有         | Web Guest 加密写作单页                           | `main.tsx`、`app.tsx`        |
| `apps/desktop/src-tauri` | 无         | Desktop 原生权限、数据、网络和系统能力           | `src/main.rs`、`src/lib.rs`  |
| `apps/cloud-api/src`     | 无         | Cloud HTTP API、业务服务和后台任务               | `main.ts`                    |
| `packages/*/src`         | 无业务页面 | 跨应用领域模型、用例、契约、存储及共享 UI 基础件 | 各包 `index.ts`              |
| `apps/android`           | 当前无     | Android 离线同步、密文缓存和 KeyStore POC        | `core/`、`android-keystore/` |
| `deploy/`                | 无         | Enterprise 容器、Kubernetes、监控和升级          | `deploy/enterprise/`         |
| `scripts/`               | 无         | 发布、安全检查、备份恢复和 E2E 驱动              | 根 `package.json` scripts    |
| `tests/`                 | 无         | 跨应用 Desktop E2E                               | `tests/e2e/`                 |

`apps/web/src/application`、`domain`、`contracts`、`ports` 和 `infrastructure` 虽然没有页面，
仍运行在浏览器侧，不是服务端；它们的逐文件说明保留在
[`../front-end/README.md`](../front-end/README.md)。

## 依赖方向

推荐阅读顺序：

```text
domain / story-core / ai-core / sync-core / access-core
                         ↓
                 application / task-engine
                         ↓
     data / cloud-client / import-export / observability
                         ↓
       Desktop Runtime / Cloud API / Web / Android
                         ↓
                React 页面与 Tauri 壳层
```

依赖方向由 `scripts/check-boundaries.mjs` 校验。应用层和领域层不应反向依赖 React、Tauri、
Fastify、PostgreSQL 或具体 UI。

## “文件存在”不等于“线上可用”

判断一个非前端能力是否真的可用，需要同时核对：

- 代码和契约是否存在；
- 运行时是否接线；
- Feature Flag 是否开启；
- Tauri 原生安全允许列表是否放行；
- PostgreSQL、对象存储、邮件、身份提供商等真实依赖是否部署；
- 数据库迁移、权限角色和 RLS 是否通过；
- 对应测试、安装或运维演练是否完成。

Cloud API 有完整的契约和大量实现，但当前工程预览版没有托管生产 Cloud；团队审阅、AI
用量、Enterprise 和团队模板等部分 Desktop 请求仍被原生中继阻止。

## 维护规则

发生以下变化时更新对应文档：

- `apps/cloud-api/src`、`migrations/` 新增或移动文件；
- `apps/desktop/src-tauri/src` 新增 command、事件、权限或网络出口；
- `packages/*/src` 新增模块或改变包边界；
- Android POC 新增 UI、真机测试或正式同步能力；
- `deploy/`、`.github/workflows/`、`scripts/` 改变发布和运维行为。

本目录属于根 `.gitignore` 允许的精选公开文档范围。发布前仍须检查暂存清单，避免把内部审计、
凭据、数据库、安装缓存或本机构建输出带入公开仓库；不要使用 `git add -f` 绕过范围。
