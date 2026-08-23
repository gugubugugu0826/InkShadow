# InkShadow Cloud API 云端后端逐文件指引

> 基于源码快照：2026-07-30  
> 覆盖范围：`apps/cloud-api/src` 的 84 个非测试源码文件、16 个 PostgreSQL 迁移及其共享契约  
> 文档状态：`SUPPORTING_CURRENT`（代码边界）；不表示生产 Cloud 已部署  
> Desktop 应用清单版本：`0.2.9`；最新公开版本：[`v0.2.7`](https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.7)（未签名工程预发行）；Cloud 仍未部署，设计基线 `DESIGN v0.3.1b` 不改变 Cloud API 版本  
> 状态口径：代码已实现不等于已经部署或通过真实生产环境验证

## 1. 定位与规模

`apps/cloud-api` 是真正的远程服务端：Node.js 24、Fastify、Zod、PostgreSQL、ESM。它负责身份、设备、项目同步、团队、评审、AI 用量、团队模板、Enterprise SSO、社区市场以及延迟删除。

- 公共接口：81 个 `/v1` operation，运行时注册表位于 `packages/contracts/src/cloud-openapi.ts`；测试和文档工具从 `@inkshadow/contracts/openapi` 显式导入生成文档，桌面运行时主入口不导出该生成器。
- 运维接口：`/health/live`、`/health/ready`，以及按配置开放的 `/internal/metrics`。
- 当前云 schema：v16。
- PostgreSQL runtime 表：51 张；另有迁移角色管理的 `cloud_schema_migrations`。
- 生产模式不自动迁移，必须先独立执行 `--migrate-only`；开发模式可自动迁移。
- 仓库包含 Enterprise Docker/Kubernetes 模板，但没有证据表明 Cloud API 已部署到真实生产环境。

```text
Desktop / 可信客户端
  → packages/cloud-client
  → packages/contracts 输入校验
  → HTTPS / Fastify 路由
  → request ID、认证、限流、幂等
  → service 权限与业务规则
  → repository 事务端口
  → postgres 实现
  → PostgreSQL CAS、RLS、审计
  → contracts 输出校验
```

## 2. HTTP 能力分组

逐 operation 的方法、路径、鉴权、请求和响应见 [`../front-end/INTERFACE_REFERENCE.md`](../front-end/INTERFACE_REFERENCE.md)。

| 分组             | 数量 | 内容                                           | 主要服务                     |
| ---------------- | ---: | ---------------------------------------------- | ---------------------------- |
| 身份、认证、设备 |   12 | 注册、验证、重置、登录、刷新、注销、会话和设备 | `CloudIdentityService`       |
| 账户与项目删除   |    6 | 申请、查询和取消                               | `CloudDeletionDomainService` |
| 项目密钥与同步   |    8 | 密钥、项目状态、push/pull/snapshot、墓碑确认   | `CloudProjectSyncService`    |
| 团队与 RBAC      |    9 | 团队、成员、邀请、角色、撤销和项目分配         | `CloudTeamService`           |
| 团队项目密钥     |    4 | 当前版本、接收设备、发布和读取 envelope        | `CloudTeamProjectKeyService` |
| 加密评审         |    9 | 评审、决定、线程、评论和建议                   | `CloudReviewService`         |
| AI 用量与预算    |    7 | 预算、汇总、事件、预留、结算和取消             | `CloudAiUsageService`        |
| 加密团队模板     |   10 | 模板、版本、克隆、发布、归档和应用记录         | `CloudTeamTemplateService`   |
| Enterprise       |    6 | 策略、评估、SSO 状态、OIDC 开始和回调          | Enterprise services          |
| 社区市场         |   10 | 目录、投稿、审核、举报、申诉、处置和下载       | `CloudMarketplaceService`    |

所有修改类操作使用 `Idempotency-Key`。认证操作使用 Bearer access token；公共身份和 OIDC 操作另有按 IP、邮箱、token 或 scope 的频率限制。

## 3. 根入口

| 文件                                 | 内容                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `apps/cloud-api/src/config.ts`       | 汇总数据库、HTTPS、代理、密码学密钥、投递、删除、维护、Enterprise、市场和邀请配置；拒绝重复使用密码学密钥。 |
| `apps/cloud-api/src/main.ts`         | 组合根：解析启动模式，建立连接池、仓储、服务、HTTP server 和三个后台任务，并处理 SIGINT/SIGTERM 优雅关闭。  |
| `apps/cloud-api/src/startup-mode.ts` | 只接受普通 runtime 或单一 `--migrate-only` 启动模式。                                                       |

## 4. 删除任务

| 文件                                             | 内容                                                           |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `apps/cloud-api/src/deletion/configuration.ts`   | 30 天宽限、30 天备份保留、批量、租约、重试和阻塞复查默认配置。 |
| `apps/cloud-api/src/deletion/periodic-runner.ts` | 可取消的周期删除循环；单轮失败不会终止 runner。                |

删除 worker 按“冻结 → 派生数据 → 密文 → 密钥 → 访问关系 → 删除标记 → 验证 → 备份等待 → 完成”推进，并使用租约、检查点和审计。

## 5. 外部投递

| 文件                                                           | 内容                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `apps/cloud-api/src/delivery/http-challenge-notifier.ts`       | 向凭据隔离的 HTTPS 服务投递验证码/重置码；带 Bearer token、投递 ID、幂等键、超时并禁止重定向。 |
| `apps/cloud-api/src/delivery/http-team-invitation-notifier.ts` | 向外部 HTTPS 服务投递团队邀请 token、角色和到期时间。                                          |

仓库没有实际邮件/SMS 服务；端点、secret、退信、下游幂等、模板、域名信誉和告警必须在部署环境验证。

## 6. 领域记录

| 文件                                                         | 内容                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `apps/cloud-api/src/domain/records.ts`                       | 账户、挑战、设备、会话、通用幂等、审计和分页锚点。            |
| `apps/cloud-api/src/domain/project-records.ts`               | 项目、访问、密钥、同步操作、密文块、墓碑和同步批次。          |
| `apps/cloud-api/src/domain/deletion-records.ts`              | 删除任务、子任务、删除标记、保留锁、影响统计及删除状态机。    |
| `apps/cloud-api/src/domain/team-records.ts`                  | 团队、成员、邀请、项目分配、团队审计和团队项目密钥 envelope。 |
| `apps/cloud-api/src/domain/team-invitation-outbox-record.ts` | 邀请投递 pending/processing/delivered/dead-letter 等状态。    |
| `apps/cloud-api/src/domain/review-records.ts`                | 加密评审、讨论线程和讨论项。                                  |
| `apps/cloud-api/src/domain/usage-records.ts`                 | AI 预算、月用量、预留、幂等和事件。                           |
| `apps/cloud-api/src/domain/team-template-records.ts`         | 加密团队模板、版本和应用记录。                                |
| `apps/cloud-api/src/domain/enterprise-records.ts`            | Enterprise 策略、OIDC flow/binding 和成员解析。               |
| `apps/cloud-api/src/domain/marketplace-records.ts`           | 市场作品、版本、举报、申诉、审核、下载、幂等和队列。          |

## 7. Enterprise

| 文件                                             | 内容                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `apps/cloud-api/src/enterprise/configuration.ts` | 验证签名 Enterprise license、deployment ID、能力和团队范围，并加载 OIDC 配置。                   |
| `apps/cloud-api/src/enterprise/oidc-client.ts`   | OIDC discovery、授权码交换、JWKS 缓存、RS256 ID token 及 issuer/audience/nonce/时间/email 验证。 |

真实使用仍需要商业许可证、签名公钥、deployment ID、OIDC provider、client secret 和 redirect URI。

## 8. HTTP 层

| 文件                                              | 内容                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/cloud-api/src/http/server.ts`               | Fastify 总入口：64 MiB body 上限、UUIDv7 request ID、HTTPS、安全头、错误归一化、认证、限流和路由注册。 |
| `apps/cloud-api/src/http/rate-limiter.ts`         | 限流端口和内存固定窗口实现，主要用于测试或未注入 PostgreSQL limiter 时。                               |
| `apps/cloud-api/src/http/team-routes.ts`          | 团队、成员、邀请、分配和团队密钥路由。                                                                 |
| `apps/cloud-api/src/http/review-routes.ts`        | 9 个加密评审与讨论路由。                                                                               |
| `apps/cloud-api/src/http/usage-routes.ts`         | 7 个 AI 预算与用量路由。                                                                               |
| `apps/cloud-api/src/http/team-template-routes.ts` | 10 个模板、版本、克隆、发布、归档和应用路由。                                                          |
| `apps/cloud-api/src/http/enterprise-routes.ts`    | 6 个策略和 OIDC 路由。                                                                                 |
| `apps/cloud-api/src/http/marketplace-routes.ts`   | 10 个市场目录、投稿、审核、举报、申诉、下载和队列路由。                                                |

## 9. 维护与指标

| 文件                                                | 内容                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/cloud-api/src/maintenance/configuration.ts`   | 每 5 分钟维护、250 行批次及挑战、幂等、会话、同步批次、墓碑保留默认值。                  |
| `apps/cloud-api/src/maintenance/periodic-runner.ts` | 可由 `AbortSignal` 中断的周期维护循环。                                                  |
| `apps/cloud-api/src/operations/metrics.ts`          | Prometheus 文本指标：部署模式、运行时间、ready、HTTP、连接池和 Enterprise license 时间。 |

## 10. PostgreSQL 实现

| 文件                                                          | 内容                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/cloud-api/src/postgres/configuration.ts`                | runtime/migration URL、角色、TLS 和 CA 校验；生产要求角色分离和 `sslmode=verify-full`。 |
| `apps/cloud-api/src/postgres/database-roles.ts`               | 数据库角色、授权、所有权、RLS/FORCE RLS 和 security-definer 函数校验。                  |
| `apps/cloud-api/src/postgres/pool.ts`                         | TLS、CA、连接超时、空闲超时和连接数受控的连接池。                                       |
| `apps/cloud-api/src/postgres/migrations.ts`                   | 连续迁移、SHA-256、全局 advisory lock、逐迁移事务和版本账本。                           |
| `apps/cloud-api/src/postgres/identity-store.ts`               | 账户、挑战、设备、会话、幂等、审计和设备 envelope 撤销。                                |
| `apps/cloud-api/src/postgres/project-store.ts`                | 项目、访问、密钥、同步操作/块/墓碑/确认/批次。                                          |
| `apps/cloud-api/src/postgres/deletion-store.ts`               | 删除任务、影响统计、冻结/恢复、保留锁、标记和审计。                                     |
| `apps/cloud-api/src/postgres/deletion-worker.ts`              | 带租约和 `SKIP LOCKED` 的分阶段物理清除、检查点、验证、重试和备份等待。                 |
| `apps/cloud-api/src/postgres/team-store.ts`                   | 团队、成员、邀请、outbox、项目分配、密钥 envelope 和团队审计。                          |
| `apps/cloud-api/src/postgres/team-invitation-outbox-store.ts` | 邀请投递领取、fence、防重复、成功、重试、死信和取消。                                   |
| `apps/cloud-api/src/postgres/review-store.ts`                 | 评审、线程、线程项、团队/项目授权和团队审计。                                           |
| `apps/cloud-api/src/postgres/usage-store.ts`                  | 预算、月用量、预留、结算、事件和专用幂等。                                              |
| `apps/cloud-api/src/postgres/team-template-store.ts`          | 模板、版本、应用记录和相关授权资源。                                                    |
| `apps/cloud-api/src/postgres/enterprise-store.ts`             | Enterprise 策略、OIDC flow/binding、成员、设备、幂等和审计。                            |
| `apps/cloud-api/src/postgres/marketplace-store.ts`            | 市场作品、版本/body、举报、申诉、审核、下载和专用幂等。                                 |
| `apps/cloud-api/src/postgres/rate-limiter.ts`                 | 多实例共享的 PostgreSQL 原子固定窗口限流。                                              |
| `apps/cloud-api/src/postgres/maintenance-worker.ts`           | advisory lock 单实例维护和按租户有界清理。                                              |

多租户和敏感表启用并强制 RLS。生产 runtime 角色不能拥有对象、不能获得 DDL、不能继承 migration 角色，只能访问明确授权的表、序列和函数。

## 11. Repository 端口

这些文件只定义事务抽象，service 不直接依赖 SQL。

| 文件                                                            | 内容                                               |
| --------------------------------------------------------------- | -------------------------------------------------- |
| `apps/cloud-api/src/repository/identity-store.ts`               | 账户、挑战、设备、会话、幂等和审计端口。           |
| `apps/cloud-api/src/repository/project-store.ts`                | 项目、访问、密钥和同步端口。                       |
| `apps/cloud-api/src/repository/deletion-store.ts`               | 删除任务、冻结、影响、保留锁和标记端口。           |
| `apps/cloud-api/src/repository/team-store.ts`                   | 团队、成员、邀请、分配、密钥 envelope 和审计端口。 |
| `apps/cloud-api/src/repository/team-invitation-outbox-store.ts` | 邀请 outbox 领取、fence、成功、重试和取消端口。    |
| `apps/cloud-api/src/repository/review-store.ts`                 | 评审、线程、线程项和授权上下文端口。               |
| `apps/cloud-api/src/repository/usage-store.ts`                  | 预算、月用量、预留、事件和幂等端口。               |
| `apps/cloud-api/src/repository/team-template-store.ts`          | 模板、版本、应用记录和授权端口。                   |
| `apps/cloud-api/src/repository/enterprise-store.ts`             | 策略、OIDC flow/binding、成员和设备端口。          |
| `apps/cloud-api/src/repository/marketplace-store.ts`            | 市场生命周期、举报、申诉、审核和下载端口。         |

## 12. 安全辅助

| 文件                                                             | 内容                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/cloud-api/src/security/canonical-hash.ts`                  | 规范 JSON、UTF-8 SHA-256 和幂等作用域哈希。                        |
| `apps/cloud-api/src/security/identity-idempotency.ts`            | 身份请求稳定指纹；验证码等敏感值只进入 HMAC 证明。                 |
| `apps/cloud-api/src/security/device-public-key.ts`               | P-256 非压缩公钥、SHA-256 指纹和常量时间比较。                     |
| `apps/cloud-api/src/security/passwords.ts`                       | 受参数和内存约束的 scrypt 密码哈希。                               |
| `apps/cloud-api/src/security/tokens.ts`                          | 挑战码、HMAC、access/refresh token 生成；数据库只保存 token hash。 |
| `apps/cloud-api/src/security/page-cursor.ts`                     | 绑定业务类型、时间和 UUID 的 HMAC 分页游标。                       |
| `apps/cloud-api/src/security/marketplace-cursor.ts`              | 市场目录和审核队列专用签名游标。                                   |
| `apps/cloud-api/src/security/sync-cursor.ts`                     | PostgreSQL bigint remote sequence 的签名同步游标。                 |
| `apps/cloud-api/src/security/sync-snapshot-cursor.ts`            | 绑定项目、快照、水位、压缩边界和到期时间的签名游标。               |
| `apps/cloud-api/src/security/team-invitation-token-protector.ts` | AES-256-GCM 邀请 token、AAD 绑定和有限旧密钥轮换。                 |
| `apps/cloud-api/src/security/uuid-v7.ts`                         | 同毫秒有序、时钟回退仍保持单调的 UUIDv7 工厂。                     |

## 13. 业务服务

| 文件                                                          | 内容                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/cloud-api/src/service/errors.ts`                        | 认证、权限、幂等、同步、AI、Enterprise/OIDC 等标准服务错误。                  |
| `apps/cloud-api/src/service/identity-service.ts`              | 注册、验证、重置、登录、OIDC 会话、刷新、认证、注销、会话和设备管理。         |
| `apps/cloud-api/src/service/project-sync-service.ts`          | 项目密钥、状态、snapshot、push/pull、墓碑确认、设备 envelope 撤销和协议校验。 |
| `apps/cloud-api/src/service/deletion-service.ts`              | 账户/项目删除申请、读取和取消的服务端口。                                     |
| `apps/cloud-api/src/service/cloud-deletion-service.ts`        | 删除申请、影响计算、冻结、所有权阻塞、凭据式查询/取消和审计。                 |
| `apps/cloud-api/src/service/team-service.ts`                  | 团队、成员、邀请、角色、撤销、项目分配；保护最后一个 owner 并使用修订 CAS。   |
| `apps/cloud-api/src/service/team-project-key-service.ts`      | 当前密钥、合资格设备、团队 envelope 发布与当前设备读取。                      |
| `apps/cloud-api/src/service/review-service.ts`                | 加密评审、线程状态机、评论、建议、决定、分页和审计。                          |
| `apps/cloud-api/src/service/usage-service.ts`                 | 预算、汇总、预留、结算、取消、价格版本、上限和租约。                          |
| `apps/cloud-api/src/service/team-template-service.ts`         | 加密模板/版本、克隆、发布、归档、应用和 envelope 权限。                       |
| `apps/cloud-api/src/service/enterprise-policy-service.ts`     | Enterprise 策略、评估、SSO 强制、导出/外连/支持包/设备/会话限制。             |
| `apps/cloud-api/src/service/enterprise-oidc-service.ts`       | PKCE/nonce/state、OIDC 回调、域名/成员/设备校验、subject binding 和会话签发。 |
| `apps/cloud-api/src/service/marketplace-service.ts`           | 投稿、目录、审核、举报隔离、撤回、申诉、处置、下载和高风险确认。              |
| `apps/cloud-api/src/service/team-invitation-outbox-worker.ts` | 投递领取、token 解密、退避、最大尝试、死信和无效邀请取消。                    |

## 14. 团队邀请 runner

| 文件                                                | 内容                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/cloud-api/src/team/configuration.ts`          | 邀请端点/token、AES 密钥、key ID 和最多 3 个旧密钥；拒绝半配置。 |
| `apps/cloud-api/src/team/outbox-periodic-runner.ts` | 可取消的邀请 outbox 周期循环；主程序当前每 5 秒执行。            |

## 15. PostgreSQL 迁移

| 版本 | 文件                                                                  | 内容                                                 |
| ---: | --------------------------------------------------------------------- | ---------------------------------------------------- |
|    1 | `apps/cloud-api/migrations/0001_cloud_foundation.sql`                 | 身份、项目、密钥、同步、限流、幂等、审计和基础 RLS。 |
|    2 | `apps/cloud-api/migrations/0002_maintenance_retention_indexes.sql`    | 维护和保留索引。                                     |
|    3 | `apps/cloud-api/migrations/0003_sync_compaction_floor.sql`            | 最低可用 sequence 与 compaction epoch。              |
|    4 | `apps/cloud-api/migrations/0004_idempotency_response_snapshots.sql`   | 幂等响应快照与状态。                                 |
|    5 | `apps/cloud-api/migrations/0005_project_state_and_sync_snapshots.sql` | 项目状态、密钥发布和同步 snapshot。                  |
|    6 | `apps/cloud-api/migrations/0006_sync_protocol_v2_object_types.sql`    | 同步协议 v2 对象类型与约束。                         |
|    7 | `apps/cloud-api/migrations/0007_portable_sync_integer_bounds.sql`     | 跨语言安全整数边界。                                 |
|    8 | `apps/cloud-api/migrations/0008_cloud_deletion_jobs.sql`              | 删除任务、标记、保留锁和防复活触发器。               |
|    9 | `apps/cloud-api/migrations/0009_studio_team_rbac.sql`                 | 团队、邀请/outbox、分配、审计和 RBAC/RLS。           |
|   10 | `apps/cloud-api/migrations/0010_team_project_key_envelopes.sql`       | 团队项目密钥 envelope 与设备撤销联动。               |
|   11 | `apps/cloud-api/migrations/0011_studio_encrypted_reviews.sql`         | 加密评审、线程、状态约束和 RLS。                     |
|   12 | `apps/cloud-api/migrations/0012_ai_usage_budgets.sql`                 | 预算、月用量、预留、幂等和 append-only 事件。        |
|   13 | `apps/cloud-api/migrations/0013_idempotency_snapshot_hardening.sql`   | 幂等快照摘要和约束加固。                             |
|   14 | `apps/cloud-api/migrations/0014_encrypted_team_templates.sql`         | 加密模板、版本、应用和状态约束。                     |
|   15 | `apps/cloud-api/migrations/0015_enterprise_sso_policies.sql`          | Enterprise 策略、OIDC flow/binding 和 SSO 解析。     |
|   16 | `apps/cloud-api/migrations/0016_community_marketplace.sql`            | 市场作品、版本、举报、申诉、审核、下载和 RLS。       |

已发布迁移不能重写，只能追加。生产迁移需由独立 migration role 运行。

## 16. 当前接入不完整或需真实环境验证

### 16.1 市场运营身份尚未接通

`createCloudApiServer` 当前把标准会话 principal 映射为 `platformRole=member`、`strongMfa=false`，而审核队列、版本审核、举报/申诉处置要求 `platform_ops`，高风险动作还要求强 MFA。因此：

- 路由、服务、数据库和契约已实现；
- 标准会话不能执行这些运营接口；
- 必须接入独立、可审计的运营身份与强 MFA 后才能标为可用。

### 16.2 外部数据清除 hook 未接真实实现

删除 worker 定义了 `CloudDeletionExternalPurgePort`，但组合根未注入对象存储/备份等真实清除器，默认实现报告无阻塞。未来存在数据库外副本时必须先接入此 port；数据库删除完成不能自动证明外部副本已删除。

### 16.3 原生密码边界

以下四个操作不能经普通 Fetch transport 传递密码：

- `accountDeletions.request`
- `accountDeletions.lookup`
- `accountDeletions.cancel`
- `projectDeletions.request`

它们必须经过 Desktop 受信任原生命令。其他客户端若没有等价的可信边界，应失败关闭。

### 16.4 其他真实环境项目

- PostgreSQL 集成测试需要 `INKSHADOW_TEST_POSTGRES_URL`；缺失时会跳过。
- 需验证迁移、RLS 跨租户拒绝、角色隔离、并发锁、CAS、删除和大数据量维护。
- Enterprise OIDC、挑战/邀请投递均需要真实外部服务和 secret。
- AI 用量模块不调用模型，也不含支付、发票或商业计费供应商。
- `deploy/enterprise` 是部署模板和脚本，不是已上线证明；仍需域名、TLS、secret manager、数据库、监控、告警、WAF、备份恢复和滚动升级演练。
