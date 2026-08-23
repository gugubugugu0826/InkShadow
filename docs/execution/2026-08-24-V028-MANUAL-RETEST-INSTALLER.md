# InkShadow 0.2.8 人工复测安装包记录

> 日期：2026-08-24  
> 状态：本地未签名人工复测包已生成并保留；未推送、未打标签、未发布。

## 证据边界

- 最新公开版本仍为不可变的 `v0.2.7`；其标签、安装包和发布附件没有移动或替换。
- 0.2.8 安装包来源提交为 `5cf76d410652c40eec13fd1a372fd6cacec8b2a6`。
- 未执行真实服务商、真实凭据、付费模型调用或真实计费核对。
- 本记录证明构建与静态校验，不证明安装、升级、卸载、重装、真机恢复或人工界面矩阵通过。

## 版本前移

根清单、桌面清单、Tauri 配置、Rust 清单、Rust 锁定文件中的应用包、浏览器诊断回退和诊断测试断言均从 0.2.7 同步前移至 0.2.8。第三方依赖 `libdbus-sys 0.2.7` 保持不变。

## 命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过；锁文件未变化，589 个依赖从本机缓存恢复 |
| `pnpm check:desktop-release` | 通过；正式打包配置与四处权威版本一致 |
| `cargo metadata --no-deps --format-version 1 --manifest-path apps/desktop/src-tauri/Cargo.toml` | 应用包版本为 0.2.8 |
| `pnpm --filter @inkshadow/desktop test -- src/infrastructure/diagnostics.test.ts` | 清理后的首次运行因共享包编译输出尚未重建而未收集测试；重建依赖后 5／5 通过 |
| `pnpm --filter @inkshadow/desktop typecheck` | 同一环境前置问题修复后通过 |
| `pnpm --filter @inkshadow/desktop tauri:build:unsigned` | 通过；正式网页 2300 个模块，未签名 NSIS 安装器生成 |
| `pnpm release:verify:unsigned` | 通过；正式配置、来源提交、网页文件清单与哈希一致 |

只修改版本来源，因此没有重复运行刚完成的完整源码、原生层和 17 项正式网页旅程；本安装包是人工复测制品，不是完整未签名发布候选。

## 保留制品

- 安装包：`D:/InkShadow/installer/v0.2.8-manual-retest/InkShadow_0.2.8_x64-setup.exe`
- 大小：7,736,030 字节
- SHA-256：`c68fee3561abaf4e9972630bb3278a6b53aeda6f48229b69f7aeb05b607b52f0`
- 内部产品版本／文件版本：0.2.8／0.2.8
- 签名状态：未签名
- 来源清单：`D:/InkShadow/installer/v0.2.8-manual-retest/inkshadow-release-manifest.json`
- 来源指纹：1297 个文件、22,346,527 字节，SHA-256 `c125ef56b5ab4d3b1c9767d6d119e6287968e09aab000bff018419bf4bd93037`
- 正式网页指纹：59 个文件、7,281,944 字节，SHA-256 `f41106712cada1081d16deeca4edac533e871b169f2b611b347e4dd9b733d047`

Tauri 原始安装器以产品名生成，随后在不覆盖任何既有文件的前提下复制为用户指定名称；复制前后 SHA-256 完全相同。

## 工作区清理

- 已删除 40 个 Git 忽略且不含受版本控制文件的可再生目录，没有跳过项。
- 依赖目录：根目录，`apps/cloud-api`、`apps/desktop`、`apps/web`，以及 17 个工作区包的 `node_modules`。
- 包编译输出：`access-core`、`ai-core`、`cloud-client`、`config`、`contracts`、`data`、`domain`、`import-export`、`observability`、`platform`、`search-core`、`story-core`、`sync-core`、`task-engine`、`ui` 的 `dist`。
- 桌面端可再生产物：`.tmp`、`.vite-cache`、`dist-release` 和 `src-tauri/target`。
- `installer/v0.2.8-manual-retest` 目录及其中的安装包、来源清单明确保留；清理后安装包 SHA-256 再次核对一致。

## 尚未执行

- 没有启动该安装程序，也没有写入真实用户数据。
- 没有执行 v0.2.7 到 0.2.8 的真实安装升级、卸载、重装或回滚。
- 没有执行另一台机器、真实 Windows 系统百分之二百缩放、输入法、权限、磁盘不足和强制结束进程恢复矩阵。
- 没有推送主分支、创建 0.2.8 标签或 GitHub Release；发布必须等待单独指令。

