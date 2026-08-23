# InkShadow Android、部署、发布与工程工具指引

> 基于源码快照：2026-07-30  
> 文档状态：`SUPPORTING_CURRENT`（工程索引）；Android 仍是 POC  
> Desktop 应用清单版本：`0.2.8`；最新公开版本：[`v0.2.7`](https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.7)（未签名工程预发行）；Android 仍为 POC，设计基线 `DESIGN v0.3.1b` 不代表 Android 客户端已实现  
> 本文覆盖 `apps/android`、`deploy/`、`scripts/`、`.github/`、`tests/` 和根工程配置

## 1. Android 当前不是产品客户端

`apps/android` 是架构验证 POC，不包含 Activity、Fragment、Compose、网络权限或后台服务。
它验证纯 JVM 同步规则、密文离线缓存和 AndroidKeyStore 适配边界，不能描述为已经发布的
Android App。

依赖方向：

```text
android-keystore → core
Android UI / Cloud transport → 当前不存在
```

默认 `AndroidPocFeatureFlags()` 会关闭架构、加密缓存和 E2EE 同步；未显式启用时所有受控
操作失败关闭。

## 2. Android 工程与配置文件

| 文件                                                         | 内容                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `apps/android/settings.gradle.kts`                           | Plugin/依赖仓库解析，并按 `-Pinkshadow.includeAndroidSdkModule=true` 可选注册 Android SDK 模块 |
| `apps/android/build.gradle.kts`                              | 注册架构边界、禁止正文快照和聚合 `check` 验证任务                                              |
| `apps/android/gradle.properties`                             | Gradle/Kotlin 构建参数                                                                         |
| `apps/android/core/build.gradle.kts`                         | JVM 17 的纯 Kotlin core 模块、Kotlin/JUnit 依赖与测试                                          |
| `apps/android/android-keystore/build.gradle.kts`             | 只有显式启用时解析的 Android Library；compileSdk 35、minSdk 26、Java 17                        |
| `apps/android/android-keystore/src/main/AndroidManifest.xml` | 无 Activity、Service 或网络权限的库清单                                                        |
| `apps/android/.gitignore`                                    | Android/Gradle 本地输出排除                                                                    |
| `apps/android/README.md`                                     | POC 边界、验证命令和未完成项                                                                   |

`.gradle/` 和 `build/` 是本机缓存或构建输出，不是源码，也不应进入 GitHub。

## 3. Android core 源码

### 3.1 密文离线缓存

| 文件                                                                                           | 职责                                                                                 |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/android/core/src/main/kotlin/com/inkshadow/android/poc/cache/EncryptedCacheContracts.kt` | 密文缓存记录、存储端口、稳定错误码与异常                                             |
| `apps/android/core/src/main/kotlin/com/inkshadow/android/poc/cache/EncryptedOfflineCache.kt`   | AES-GCM 密文写入/读取流程、AAD 绑定、哈希和 nonce 唯一性检查                         |
| `apps/android/core/src/main/kotlin/com/inkshadow/android/poc/cache/FileEncryptedCacheStore.kt` | 有界文件存储适配器；临时文件写入并 `force(true)`，优先原子移动，不支持时回退普通移动 |

缓存只持久化 ciphertext、nonce、SHA-256 和非敏感绑定元数据。解密前先检查传输哈希，AAD、
ciphertext、tag 或记录损坏都会失败关闭。

### 3.2 密钥和 AAD

| 文件                                                                                      | 职责                                                 |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/android/core/src/main/kotlin/com/inkshadow/android/poc/crypto/AeadKeyHandle.kt`     | 不可导出 AEAD 密钥的加密/解密端口                    |
| `apps/android/core/src/main/kotlin/com/inkshadow/android/poc/crypto/ProjectKeyAliases.kt` | 规范化项目密钥 alias                                 |
| `apps/android/core/src/main/kotlin/com/inkshadow/android/poc/crypto/SyncAadCodec.kt`      | 与 `sync-core` 同形的同步 AAD 规范化编码；不负责解码 |

AAD 格式：

```text
inkshadow-sync-v1|projectId|objectType|objectId|versionId|chunkIndex|keyVersion
```

### 3.3 功能门禁和诊断

| 文件                                                                                            | 职责                                       |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `apps/android/core/src/main/kotlin/com/inkshadow/android/poc/feature/AndroidPocFeatureGate.kt`  | Android POC 能力开关、依赖和失败关闭       |
| `apps/android/core/src/main/kotlin/com/inkshadow/android/poc/logging/SafeAndroidEventLogger.kt` | 只允许枚举化诊断事件和结果码，禁止自由正文 |

诊断接口不接收正文、Prompt、Token、Key、恢复码、Throwable 或自由文本。

### 3.4 同步与冲突

| 文件                                                                                              | 职责                                                      |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/android/core/src/main/kotlin/com/inkshadow/android/poc/sync/VersionVectors.kt`              | 版本向量的 EQUAL/BEFORE/AFTER/CONCURRENT 比较；不提供合并 |
| `apps/android/core/src/main/kotlin/com/inkshadow/android/poc/sync/AndroidSyncPolicy.kt`           | 网络、设备信任、本机对象头和同步动作决策                  |
| `apps/android/core/src/main/kotlin/com/inkshadow/android/poc/sync/ConflictAndRevocationPolicy.kt` | 显式冲突解决和设备撤销后的密钥轮换计划                    |

离线出站只返回 `QueuedOffline`，不会伪造上传成功。并发版本只返回 `ManualConflict`，没有
last-write-wins。设备撤销会先要求轮换项目密钥，并在完成前阻止同步。

### 3.5 Wire DTO 与严格验证

| 文件                                                                                        | 职责                                                     |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `apps/android/core/src/main/kotlin/com/inkshadow/android/poc/wire/SyncWireDtos.kt`          | 设备、加密 chunk、操作、墓碑、push、pull 和 snapshot DTO |
| `apps/android/core/src/main/kotlin/com/inkshadow/android/poc/wire/StrictSyncWireDecoder.kt` | 拒绝缺失或未知字段的严格 JSON 解码                       |
| `apps/android/core/src/main/kotlin/com/inkshadow/android/poc/wire/SyncWireValidator.kt`     | UUIDv7、版本、范围、大小、墓碑和 snapshot 一致性验证     |

当前固定：

- wire schema version 1；
- 同步协议 schema version 2；
- 明文对象上限 4 MiB；
- 墓碑至少保留 365 天；
- snapshot 校验项目范围、chunk 唯一归属、delete/tombstone 对应和游标状态；
- 上游 JSON parser 仍必须拒绝重复键。

## 4. AndroidKeyStore 适配器

| 文件                                                                                                             | 职责                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/android/android-keystore/src/main/kotlin/com/inkshadow/android/keystore/AndroidKeystoreAesGcmKeyHandle.kt` | 在 AndroidKeyStore 中生成不可导出的 AES-256 密钥，并实现 AES-GCM 加解密 |

约束：

- 96-bit 随机 nonce；
- 128-bit authentication tag；
- nonce 由 KeyStore provider 生成；
- 相同 alias 的 nonce 在持久化前检查唯一性；
- nonce 连续碰撞时失败，不降级为不安全随机源。

当前缺少 Android SDK CI、instrumentation 和真机硬件 KeyStore 矩阵。

## 5. Android 测试与辅助脚本

| 文件                                                                                                | 作用                                                      |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/android/core/src/test/kotlin/com/inkshadow/android/poc/TestFixtures.kt`                       | 测试 ID、时钟、密钥和 DTO Fixture                         |
| `apps/android/core/src/test/kotlin/com/inkshadow/android/poc/JvmTestLauncher.kt`                    | 无 Gradle/SDK 时的 JVM 测试入口                           |
| `apps/android/core/src/test/kotlin/com/inkshadow/android/poc/cache/EncryptedOfflineCacheTest.kt`    | 加密缓存、损坏、nonce 和原子性                            |
| `apps/android/core/src/test/kotlin/com/inkshadow/android/poc/crypto/SyncAadCodecTest.kt`            | AAD 规范和拒绝条件                                        |
| `apps/android/core/src/test/kotlin/com/inkshadow/android/poc/logging/SafeAndroidEventLoggerTest.kt` | 诊断字段白名单                                            |
| `apps/android/core/src/test/kotlin/com/inkshadow/android/poc/sync/AndroidSyncPolicyTest.kt`         | 网络、信任、冲突和撤销策略                                |
| `apps/android/core/src/test/kotlin/com/inkshadow/android/poc/wire/SyncWireContractTest.kt`          | Wire 严格解码和验证                                       |
| `apps/android/scripts/run-jvm-tests.ps1`                                                            | 使用本机已有 Kotlin/JUnit 缓存运行纯 JVM 测试，不下载依赖 |
| `apps/android/scripts/verify-boundaries.ps1`                                                        | 静态验证 core 不依赖 Android/UI/HTTP，适配层方向正确      |

无 Android SDK：

```powershell
powershell -ExecutionPolicy Bypass -File .\apps\android\scripts\run-jvm-tests.ps1
powershell -ExecutionPolicy Bypass -File .\apps\android\scripts\verify-boundaries.ps1
```

有 SDK 时才显式运行：

```powershell
gradle -Pinkshadow.includeAndroidSdkModule=true :android-keystore:lint
```

## 6. Enterprise 部署文件

| 文件                                                              | 职责                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `deploy/enterprise/docker/Dockerfile`                             | 以固定 SHA-256 的 Node 基础镜像构建 Cloud API，生产阶段使用非 root 用户                     |
| `deploy/enterprise/kubernetes/inkshadow-enterprise.yaml.template` | ServiceAccount、迁移 initContainer、API Deployment、探针、Ingress、网络策略、PDB/HPA 等模板 |
| `deploy/enterprise/render-kubernetes.mjs`                         | 严格校验镜像、命名空间、域名、CIDR 和资源参数后渲染模板                                     |
| `deploy/enterprise/upgrade.mjs`                                   | 使用不可变镜像摘要升级；失败时回退并验证上一 Deployment revision                            |
| `deploy/enterprise/monitoring/prometheus-rules.yaml`              | 可用性、5xx、连接池、许可证、备份和恢复演练告警                                             |
| `deploy/enterprise/enterprise-deployment.test.mjs`                | 验证渲染器与部署资产的不变量；不执行真实集群升级或回滚                                      |

关键边界：

- 基础镜像和应用镜像必须是 `@sha256:<digest>` 不可变引用；
- migration role 和 runtime role 分离；
- runtime Pod 不获得 migration 数据库凭据；
- 容器为非 root、只读根文件系统、移除 Linux capabilities；
- ServiceAccount Token 不自动挂载；
- 网络出口使用明确 CIDR，不允许 `0.0.0.0/0` 作为受信边界；
- Kubernetes 模板不是已部署集群，必须在目标环境验证。

## 7. 根发布与质量脚本

| 文件                                         | 职责                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `scripts/check-boundaries.mjs`               | 校验 workspace manifest、声明依赖和主要内部边界；不是所有 app 的完整依赖白名单 |
| `scripts/check-licenses.mjs`                 | 递归检查运行时依赖的许可证允许列表；不生成 SBOM                                |
| `scripts/check-secrets.mjs`                  | 扫描源码、文档、配置和脚本中的常见凭据模式                                     |
| `scripts/desktop-release-manifest.mjs`       | 计算 Desktop 源码、环境和前端产物指纹                                          |
| `scripts/capture-desktop-release-source.mjs` | 构建前保存源码 baseline                                                        |
| `scripts/write-desktop-release-manifest.mjs` | 构建后核对 baseline 并写入产物 manifest                                        |
| `scripts/check-desktop-release.mjs`          | 校验版本、Tauri 配置、CSP、产物预算、文件数量和 release manifest               |
| `scripts/desktop-release-manifest.test.mjs`  | 发布指纹、安全路径和篡改检测回归                                               |
| `scripts/secure-update-manifest.mjs`         | 创建/验证签名更新 manifest 和 Authenticode attestation                         |
| `scripts/secure-update-manifest.test.mjs`    | 更新签名、反回滚、范围、时间和规范编码回归                                     |
| `scripts/run-e2e.mjs`                        | 启动有界本地服务器和 Playwright，Windows 下隐藏子进程窗口                      |
| `scripts/serve-e2e.mjs`                      | 只从工作区内的指定 `dist` 提供静态文件，并使用每次运行 token 做 readiness      |

`check-secrets.mjs` 会扫描 `docs/`，即使文档被 Git 忽略。它不能扫描所有二进制、Git 历史或
所有外部归档，因此仍需人工复核和凭据轮换流程。

## 8. Enterprise 备份、恢复与支持脚本

| 文件                                           | 职责                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `scripts/enterprise/backup-postgres.sh`        | 使用最小权限角色流式 `pg_dump`，age 加密并用独立 Ed25519 密钥签名 |
| `scripts/enterprise/restore-postgres.sh`       | 先验证签名再解密，只恢复到显式确认的隔离目标，并检查来源与权限    |
| `scripts/enterprise/create-support-bundle.mjs` | 从严格字段白名单生成脱敏支持包                                    |
| `scripts/enterprise/recovery-scripts.test.mjs` | 静态验证备份/恢复顺序、权限和危险目标拒绝                         |
| `scripts/enterprise/support-bundle.test.mjs`   | 验证支持包结构、上限和敏感字段拒绝                                |

备份脚本要求：

- `umask 077`；
- 加密输出不落明文临时备份；
- 备份签名私钥权限受限；
- 记录迁移 ledger 和源数据库指纹；
- 签名密钥与产品更新密钥分离。

恢复脚本要求：

- 先验签、后解密；
- 使用 libpq service 名而不是把密码放进命令行；
- 必须设置 `RESTORE_TO_ISOLATED_TARGET`；
- 拒绝源库、活动库、特权目标和不匹配数据库名；
- 恢复前检查目标角色、TLS/本地边界、无并发连接且不是源库；
- 恢复后只重新核对 schema 版本、迁移账本 SHA-256 和 FORCE RLS 表数量。

## 9. CI 与 E2E

### 9.1 GitHub Actions

文件：`.github/workflows/ci.yml`

触发：

- push 到 `main`；
- pull request；
- 手动 `workflow_dispatch`。

Job：

| Job              | 内容                                                                           |
| ---------------- | ------------------------------------------------------------------------------ |
| `quality`        | 安装锁定依赖、格式、边界、秘密、许可证、类型、Lint、测试、全仓构建和浏览器 E2E |
| `cloud-postgres` | PostgreSQL 17 服务下运行 Cloud API 全套测试与 RLS                              |
| `native`         | Rust fmt、Clippy、Rust 测试、生产前端 E2E、未签名 NSIS 打包和 7 天 Artifact    |

CI 不会自动创建 GitHub Release，也不进行 Windows Authenticode 签名。

### 9.2 根 E2E

| 文件                                    | 内容                                   |
| --------------------------------------- | -------------------------------------- |
| `playwright.config.ts`                  | Desktop 浏览器旅程配置                 |
| `tests/e2e/desktop-start.spec.ts`       | 启动页、本地开始和云入口边界           |
| `tests/e2e/desktop-local-first.spec.ts` | 项目、章节、本地保存和主要本地优先路径 |

Web Guest 自己的 E2E 位于 `apps/web/tests/e2e/encrypted-guest.spec.ts`。

## 10. 根工程配置

| 文件                  | 职责                                                |
| --------------------- | --------------------------------------------------- |
| `package.json`        | workspace 命令、Node/pnpm 版本和发布候选链路        |
| `pnpm-workspace.yaml` | `apps/*`、`packages/*` 成员、catalog 和严格依赖策略 |
| `pnpm-lock.yaml`      | 锁定依赖图                                          |
| `tsconfig.base.json`  | TypeScript 公共严格配置                             |
| `eslint.config.mjs`   | 全仓 ESLint 与 React/导入/无障碍规则                |
| `.prettierrc.json`    | 统一格式规则                                        |
| `.prettierignore`     | 构建产物和冻结输入文档排除                          |
| `.editorconfig`       | 编辑器字符集、缩进和换行约定                        |
| `.gitattributes`      | Git 文本与换行规则                                  |
| `.gitignore`          | 依赖、产物、数据库、凭据、内部文档和归档排除        |
| `.dockerignore`       | 容器构建上下文排除                                  |
| `.env.example`        | 仅包含占位符的环境变量目录，不得放真实秘密          |
| `README.md`           | 公开仓库说明                                        |

## 11. 当前不能宣称的能力

- Android 产品 UI 或可安装 APK；
- Android 真机 KeyStore、后台同步和系统级生命周期已通过；
- Enterprise Kubernetes 模板已部署到生产；
- RPO/RTO 已在生产等价环境达成；
- 备份存在就等于恢复可用；
- GitHub CI Artifact 是永久发布档案；
- 未签名 NSIS 是正式商业安装包；
- E2E 浏览器通过等于所有真实 Tauri 窗口、文件系统和凭据行为已经验证。
