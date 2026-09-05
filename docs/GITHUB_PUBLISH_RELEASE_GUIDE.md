# InkShadow GitHub 上传与 Release 发布注意事项

> 当前版本与发布目标：`0.2.18`；更新日期：2026-09-06。  
> 本轮授权：完整本地门禁通过后，安全同步并推送 main、创建新说明标签、创建 Release、上传和回下载核验。  
> 不授权：真实付费模型调用、强制推送、清空用户数据库、删除作品、移动旧标签或覆盖旧附件。  
> 安装包未签名时，必须标注“未签名工程预览”且 Release 只能预发行。

## 0.2.18 当前发布流程

本节与 [当前发布门禁](execution/RELEASE_CHECKLIST.md) 适用于本轮。文末保留的 0.2.17 及更早操作是历史参考，不能照搬其中版本号、附件清单或旧授权限制。

1. 只读核对仓库规则、现有改动、远端 main、标签、报告与来源证据。确认 0.2.18 未被占用，保护旧发布对象及 0.2.17 人工复测安装包。
2. 缺陷先有稳定失败回归，再修复并运行完整本地门禁；原现场材料或真实验证未取得时如实说明。模型结果隔离、原子版本、私密零远程发送和零自动重试不得降低。
3. 最后更新根清单、桌面清单、Tauri、Cargo 与应用锁文件版本、诊断回退版本、安装包检查脚本、对应测试和当前文档。第三方依赖版本及历史文档中的旧版本不得机械全替换。
4. 整理可审计提交，安全同步 main，合入后来源必须干净且唯一。同步或文档修订导致提交变化时，不能把前一提交的结果称作最终验证。
5. 从最终干净提交执行仓库完整候选链：

```powershell
$env:CI = "true"
pnpm release:candidate:unsigned
Remove-Item Env:CI
```

若测试环境需要隔离数据库，只使用本轮新建的测试实例并记录地址与生命周期，不读取用户凭据、不清空用户数据库。未配置真实模型的可选项须明确列出跳过原因；关键安全回归缺失不能以退出码成功替代。

候选链包含以下准确入口，任意失败即停止远端发布：

- `pnpm release:check`：构建、格式、敏感信息、许可证、架构边界、发布配置、类型、代码规范、脚本与完整工作区测试；
- `pnpm check:rust`：原生格式、严格静态检查和测试；
- `pnpm test:e2e:release`：同提交正式前端、来源校验和完整浏览器旅程；
- `pnpm --filter @inkshadow/desktop tauri:package:unsigned:prebuilt`；
- `pnpm release:verify:installer-version`；
- `pnpm release:verify:unsigned`。

6. 原始安装程序必须恰好为 `墨影 InkShadow_0.2.18_x64-setup.exe`。直接检查产品版本、文件版本、品牌、应用载荷 AMD64 及未签名状态，不能只读配置文件代替安装包检查。Windows 四段版本 `0.2.18.0` 规范化为 `0.2.18`。
7. 按原字节复制为 `installer/v0.2.18/InkShadow_0.2.18_x64-setup.exe`，核对复制前后大小与 SHA-256。同目录保留五项附件：

- `InkShadow_0.2.18_x64-setup.exe`；
- `InkShadow_0.2.18_SOURCE_MANIFEST.json`；
- `SHA256SUMS.txt`；
- `InkShadow_0.2.18_VALIDATION_REPORT_zh-CN.md`；
- `InkShadow_0.2.18_RELEASE_NOTES_zh-CN.md`。

校验文件列出其余四项附件；它自身的大小和哈希另记在最终交付记录，避免自引用循环。验证报告须包含当前提交、来源指纹、逐项缺陷、准确命令及统计、未取得材料、未执行项、延期、风险和人工复测步骤。发布说明及 README 使用正式中文产品文案，不把受控服务称作真实供应商验证。

8. 再次读取远端 main 与版本占用情况。只有快进安全且提交与通过门禁的来源一致时才推送；不强推，不覆盖他人提交。在准确提交创建带说明的 `v0.2.18` 标签，只推送这个新标签，不批量推送旧标签。
9. 使用上述五项文件创建预发行，并将目标绑定为完整提交 SHA。标签必须已经存在，不能让发布操作隐式猜测来源：

```powershell
gh release create v0.2.18 --verify-tag --prerelease --target $releaseCommit --title "墨影 InkShadow 0.2.18" --notes-file installer/v0.2.18/InkShadow_0.2.18_RELEASE_NOTES_zh-CN.md @releaseAssets
```

`$releaseCommit` 必须来自已经通过完整门禁的干净提交；`$releaseAssets` 必须是上方五项准确路径的数组，不得用未经核对的当前分支或通配符猜测来源。

10. 下载到新的核验目录，逐个比较大小和 SHA-256；重新核对远端 main、标签解析后的提交、Release 目标、来源清单与安装包来源一致。身份验证、网络或权限失败时保留本地产物并报告准确阻断，不伪造成功。
11. 回下载全部通过后再清理依赖、编译输出和测试缓存。逐个检查解析后的目标位于仓库内，保留源码、数据库、备份、旧交付物和本轮证据。临时测试服务停止后再交付，不删除用户数据库。

## 历史指南存档：0.2.17 及更早轮次

**从下方开始直到本文件结尾均为历史参考。** 其中“当前”“本轮”“未授权”等用语仅指当时的旧轮次；0.2.18 必须执行上方当前流程，不能沿用旧版本附件名、旧提交结果或旧发布限制。历史内容保留以便审计，不是平行的当前发布入口。

> 适用仓库：`gugubugugu0826/InkShadow`  
> 仓库可见性：Public  
> 默认分支：`main`  
> 适用环境：Windows PowerShell  
> 历史指南日期：2026-09-02  
> 历史轮次目标：`0.2.17` 人工复测候选；当时仅授权本地附件，该限制不适用于另行授权的 0.2.18  
> 当时公开版本：`v0.2.16`；其标签、Release、安装包和全部附件继续保持不可变

本文是每次向 GitHub 上传源码或发布安装包时必须执行的检查清单。它只描述操作流程，
不替代 [`execution/RELEASE_CHECKLIST.md`](execution/RELEASE_CHECKLIST.md) 中的产品发布门禁。
`v0.2.3`–`v0.2.16` 的已发布或候选事实分别记录在对应专项文档与门禁文档；后续版本在实际候选生成前仍保持“未运行”，
不得沿用任何历史版本数据。

## 0.2.17 人工复测候选边界

0.2.17 只能从唯一干净提交完成本地门禁和未签名 Windows x64 候选构建。本轮交付在候选附件校验与可再生资源清理后停止；真实安装人工复测完成并取得单独发布指令前，不得推送当前候选、创建 `v0.2.17` 标签、创建草稿或公开 GitHub Release，也不得把本地文件描述为 GitHub 发布附件。

0.2.17 本地人工复测附件固定为：

- `InkShadow_0.2.17_x64-setup.exe`；
- `InkShadow_0.2.17_SOURCE_MANIFEST.json`；
- `SHA256SUMS.txt`；
- `InkShadow_0.2.17_VALIDATION_REPORT_zh-CN.md`；
- `InkShadow_0.2.17_MANUAL_RETEST_GUIDE_zh-CN.md`。

Tauri 原始构建产物名为 `墨影 InkShadow_0.2.17_x64-setup.exe`；人工复测目录只允许按原字节复制为上述 ASCII 安装包名，复制前后大小与 SHA-256 必须完全一致，不得重新打包或按修改时间猜测“最新”文件。`SHA256SUMS.txt` 只校验其余四项附件；它自身的大小和 SHA-256 另行记录。安装程序还必须直接核对 ProductVersion、FileVersion、架构和 Authenticode 状态，配置文件版本不能替代制品检查。

来源提交、来源指纹、附件大小、摘要和门禁统计只能在当前候选实际产生后写入验证报告，不能沿用 0.2.16 或更早结果。当前源码迁移上限仍为 Data `0082`／Tauri `85`，0.2.17 没有新增迁移，也不得修改已发布迁移或校验值。

## 0.2.16 预发行边界（历史）

0.2.16 只能从唯一干净提交生成安装程序、来源清单、校验文件、完整中文验证报告和正式中文发布说明。安装程序未签名时必须明确标记“未签名”，GitHub Release 必须设为预发行。完整本地候选链、远端持续集成、标签、Release 来源和所有附件必须指向同一提交；任何门禁失败都应停止在标签与 Release 之前。

0.2.16 GitHub 公开附件名称固定为：

- `InkShadow_0.2.16_x64-setup.exe`；
- `inkshadow-release-manifest.json`；
- `SHA256SUMS`；
- `InkShadow_0.2.16_VALIDATION_REPORT_zh-CN.md`；
- `InkShadow_0.2.16_RELEASE_NOTES_zh-CN.md`。

Tauri 本地构建产物仍固定为 `墨影 InkShadow_0.2.16_x64-setup.exe`。上传前只允许把该文件按原字节复制为上述 ASCII 公开名称；复制前后大小和 SHA-256 必须完全一致，不得重新打包。GitHub 会规范化包含空格或非 ASCII 字符的附件名，公开 `SHA256SUMS` 必须使用最终公开名称。

`SHA256SUMS` 只覆盖其余四个公开附件；它自身的大小和 SHA-256 另行记录。提交、大小、摘要和 Release 链接不得预填，只能在候选及发布事实产生后写入验证报告。安装包生成后必须直接读取 Windows ProductVersion、FileVersion 和 Authenticode 状态；配置文件版本不能替代实际制品检查。

## 0.2.15 预发行边界（历史）

0.2.15 只能从唯一干净提交生成安装程序、来源清单、校验文件、完整中文验证报告和正式中文发布说明。安装程序未签名时必须明确标记“未签名”，GitHub Release 必须设为预发行。完整本地候选链、远端持续集成、标签、Release 来源和所有附件必须指向同一提交；任何门禁失败都应停止在标签与 Release 之前。

0.2.15 历史 GitHub 公开附件名称为：

- `InkShadow_0.2.15_x64-setup.exe`；
- `inkshadow-release-manifest.json`；
- `SHA256SUMS`；
- `InkShadow_0.2.15_VALIDATION_REPORT_zh-CN.md`；
- `InkShadow_0.2.15_RELEASE_NOTES_zh-CN.md`。

该版本的 Tauri 本地产物名为 `墨影 InkShadow_0.2.15_x64-setup.exe`，GitHub 公开附件已规范化为上述 ASCII 名称，公开 `SHA256SUMS` 也使用该名称。`SHA256SUMS` 只覆盖其余四个附件；它自身的大小和 SHA-256 另行记录。安装包生成后必须直接读取 Windows ProductVersion、FileVersion 和 Authenticode 状态；配置文件版本不能替代实际制品检查。

## 0.2.14 预发行边界（历史）

0.2.14 只能从唯一干净提交生成 `InkShadow_0.2.14_x64-setup.exe`、来源清单、校验文件、完整中文验证报告和正式中文发布说明。安装包未签名，必须明确标为“未签名工程预览”，GitHub Release 必须设为预发行。候选提交 `b4ec54feb51dc651201daa14e635b261bd9f592c` 已完整通过 `release:candidate:unsigned`，正式发布端到端为 26／26；正式 README 与发布决定改变源码指纹后，必须从新的唯一提交重新构建全部附件。最新用户指令授权在最终候选链、三项远端持续集成和附件同源复核全部成功后推送、打标签并发布；真实安装、真实模型、真人交互和系统 200% 缩放仍须在发布说明中如实标注为未执行。

0.2.14 发布附件名称固定为：

- `InkShadow_0.2.14_x64-setup.exe`；
- `inkshadow-release-manifest.json`；
- `SHA256SUMS`；
- `InkShadow_0.2.14_VALIDATION_REPORT_zh-CN.md`；
- `InkShadow_0.2.14_RELEASE_NOTES_zh-CN.md`。

`SHA256SUMS` 只覆盖其余四个附件；它自身的大小和 SHA-256 另行记录。提交、大小、摘要和 Release 链接不得预填，只能在候选及发布事实产生后写入验证报告。

`v0.2.9` 已从来源提交 `54d9647031bb97b4fc9f021d3b1acca7f6d25c47` 发布为未签名工程预发行，
其标签、Release 和附件均为不可移动历史。

## v0.2.16 及更早版本保留边界

已发布的 v0.2.16 标签、Release、安装包和附件，以及 v0.2.15 与更早候选的安装包、来源清单、校验文件、验证报告和来源证据均保持不可变。尤其不得覆盖、移动或改作 0.2.17 人工复测附件，也不得替换任何既有公开附件。

0.2.8 人工复测包及其来源清单继续保留在 `D:/InkShadow/installer/v0.2.8-manual-retest/`；本轮清理
只处理可再生成资源，不删除任何既有候选或发布证据。

## v0.2.7 已发布记录

`v0.2.7` 是已经公开的未签名 Windows x64 工程预发行，不是正式商业版本。以下事实只适用于
这个不可变候选，不得挪作后续版本证据：

| 项目       | 已复核事实                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 来源       | 最终候选与标签解析提交均为 `cb97876894d6f02c4c901745c95533da7b0260fe`；带说明标签对象为 `37a40ddff9ea9aba27549f13f27718e319e2748e`；来源指纹为 1,257 个文件 / 21,687,616 字节 / SHA-256 `5d9bb2ba0ea0e5e715708d4bb9715f9846547d79de20c2fe16577d0db8ee5e95`；网页制品指纹为 59 个文件 / 7,170,926 字节 / SHA-256 `10eb6efcaed652f40f18fe586ad4faacc2c56e6a9427847b66b585c1883ec4c3`。 |
| 本地门禁   | 正式候选浏览器旅程 17/17 通过；Rust 测试 194 项通过、1 项忽略；全工作区测试 3,558 项通过、65 项跳过。                                                                                                                                                                                                                                                                                |
| 远端门禁   | [持续集成运行 32604363119](https://github.com/gugubugugu0826/InkShadow/actions/runs/32604363119) 全绿；云数据库作业 `97107172455`、类型/检查/测试/网页构建作业 `97107172584`、Windows 原生外壳作业 `97107172588` 均成功。                                                                                                                                                            |
| 发布       | <https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.7>；`draft=false`、`prerelease=true`；`publishedAt=2026-08-22T23:35:10Z`。                                                                                                                                                                                                                                            |
| 公开附件   | 恰好三个：`InkShadow_0.2.7_x64-setup.exe` 7,709,375 字节 / SHA-256 `6026918e47100360fad564cd17a15070d448ab6b460dfbf5f72467e71a23622b`；`inkshadow-release-manifest.json` 11,710 字节 / SHA-256 `f1b94f50fb98b24ae634a3d5307c729693d70134946384de923806e511b77685`；两行 `SHA256SUMS` 194 字节 / SHA-256 `fa811ff9962a92e4b247d17407dd2be97c4c4b722888ec4d76a3c3e0c2598b87`。         |
| 公开复核   | 三个附件已回下载到全新目录 `D:\InkShadow\installer\v0.2.7-download-verification-20260822-233551`；名称、数量、字节数、逐文件摘要、两行校验和发布清单中的候选提交全部匹配。                                                                                                                                                                                                           |
| 签名       | 安装程序未签名；本轮仅发布为 Windows 10 / 11 x64 工程预发行，不得描述为正式商业版本。                                                                                                                                                                                                                                                                                                |
| 未执行边界 | 以下项目均未执行，不能从自动化门禁推断为已通过：真实供应商调用、真实凭据、付费验证与文学质量人工验收；本次安装程序的安装、启动、升级、卸载、重装、迁移与恢复；另一台机器验证；真实 Windows 百分之二百缩放；桌面 WebView 的输入法、权限、磁盘不足、并发与强杀恢复；保存对话框与外部打开；百万字真实长期压力；代码签名、法律、隐私与更新通道审批。                                     |

## v0.2.6 已发布记录

| 项目       | 已复核事实                                                                                                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 来源       | 带说明标签对象 `f17fde56d83688bf6044a47c77794ebf0a46a936`；标签解析与打包来源均为 `b744d042eeafdd9db586388d71e701b1d937f366`；发布后的文档提交可以推进 `main`，但不得移动标签或改写发布清单                                                                                                                              |
| 远端门禁   | 最终运行 `32497107722` 全绿；质量作业 `96818021976`、Windows 作业 `96818022324`、云数据库作业 `96818022362` 均成功                                                                                                                                                                                                       |
| 发布       | <https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.6>；`draft=false`、`prerelease=true`；`publishedAt=2026-08-21T15:52:45Z`                                                                                                                                                                                  |
| 公开附件   | 恰好三个：`InkShadow_0.2.6_x64-setup.exe` 7,654,178 字节 / SHA-256 `c040f7861e3a25d0ca83cde85134ad2c7589e6f08e4a5e643eb8fcbcb3b0dd3a`；清单 11,522 字节 / `60a34e969a808e560ae8f4c587a4a5d5a96b225ca13cba2a8bddfb65580e78a3`；两行校验文件 194 字节 / `bca03c0535f0953eb08643d4fb1824d911ccef57ca068e424ec128a9906a7cea` |
| 公开复核   | 三个附件下载到全新目录 `installer/v0.2.6-download-verification-20260822-015245`；大小与摘要逐项一致，两行校验通过，下载清单的 `gitCommitSha` 仍为最终源码；发布说明不是附件                                                                                                                                              |
| 签名       | Windows 代码签名状态为未签名；仅作为 Windows 10 / 11 x64 工程预览                                                                                                                                                                                                                                                        |
| 未验证边界 | 正式应用标识安装程序没有启动；真实外部模型为 0 次；异机安装/升级/卸载、200% 显示缩放及 D4 的权限/磁盘/竞争/写入中强停矩阵未完成                                                                                                                                                                                          |

## v0.2.5 已发布记录

| 项目       | 已复核事实                                                                                                                                                                                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 来源       | annotated tag object `51dfd64ba22e9771131f251cdc778ee06f89192d`；tag peel 与打包来源提交均为 `5b3e212cafde10cd75fa87b7b74bfdfff9347a3d`；后续文档提交不移动标签                                                                                                                                                                              |
| Release    | <https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.5>；`draft=false`、`prerelease=true`；`publishedAt=2026-08-20T12:41:52Z`                                                                                                                                                                                                      |
| 公开附件   | installer `InkShadow_0.2.5_x64-setup.exe` 7,606,152 bytes，SHA-256 `f422467fa5fdff4236f3d453cb21de3927c89375e106ff372852f918079f20ad`；manifest 11,717 bytes，SHA-256 `4dce031a71eaa1664dcc993bd4f68362fb3d97b7843110b5ebc0b7c45b0bed0c`；`SHA256SUMS` 194 bytes，SHA-256 `0f4330efd42cd7d898497de2d0b6866fc2c9ba7b3533e8c11a233dd6a8439eec` |
| 公开复核   | 三个公开附件均重新下载并与同一最终本地 staging 文件逐字节一致；公开 `SHA256SUMS` 对安装包与 manifest 校验通过                                                                                                                                                                                                                                |
| 签名       | `Authenticode: NotSigned`；本轮是未签名 Windows 工程预览版                                                                                                                                                                                                                                                                                   |
| 未验证边界 | 真实 Provider、安装版 Windows Tauri/Wry + Credential Manager、系统 200% DPI、异机安装及四种导出的外部应用人工打开仍为 `BLOCKED_EXTERNAL`                                                                                                                                                                                                     |

## v0.2.4 已发布记录

| 项目       | 已复核事实                                                                                                                                                                                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 来源       | annotated tag object `9f613572c7f6892ba5aca4700a784c79872457e2`；tag peel 与来源提交均为 `b74d36ef3342db6813d1d43771bc82c0ed2aa1fb`                                                                                                                                                                                                          |
| Release    | <https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.4>；`draft=false`、`prerelease=true`；`publishedAt=2026-08-14T06:19:17Z`                                                                                                                                                                                                      |
| 公开附件   | installer `InkShadow_0.2.4_x64-setup.exe` 7,482,560 bytes，SHA-256 `12ba4382c79f8c7a6bea8a310c21e4f0c0663c5a7e18e9b87729bb1057628c6c`；manifest 10,551 bytes，SHA-256 `7e0a8d2cd34c38948fcf880be43c4c44b844cfe4f6df9f7870a290c7ee4016f5`；`SHA256SUMS` 194 bytes，SHA-256 `aaf721500f73cdad58b6d59b8babb9ee9924b16affc16e098b7dfc74d88262f4` |
| 签名       | 本轮远端元数据审计未重新下载检查 Authenticode；不得仅凭历史候选说明推断最终文件签名状态                                                                                                                                                                                                                                                      |
| 未验证边界 | 真实 Provider、v0.2.4 修复版 Windows Tauri/Wry + Credential Manager、系统 200% DPI 和另一台电脑安装仍为 `NOT_RUN / NOT_RETESTED`                                                                                                                                                                                                             |

## v0.2.3 已发布记录

| 项目       | 已复核事实                                                                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 来源       | PR #3 保留 exact SHA；提交与 tag peel 均为 `3abdcfeb327567c632e440d55d11f0af6f4911d2`                                                                                                                                                                                                             |
| 远端门禁   | PR run `31679607622` 与 main run `31681304602` 的 quality、Windows native shell、Cloud PostgreSQL 三项均通过                                                                                                                                                                                      |
| Release    | <https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.3>；`draft=false`、`prerelease=true`；`publishedAt=2026-08-13T08:45:32Z`                                                                                                                                                           |
| 公开附件   | installer 7,469,168 bytes，SHA-256 `23413b1bf874e1b25ab77cd156cff75472744c0e73ec830fb83ef98048ea2bb4`；manifest 10,167 bytes，SHA-256 `cd047a59e2bbb13e71f4263ba86feffab115cf47d7d9f7b396ab5d2d56111417`；`SHA256SUMS` SHA-256 `89ad2c671bdaefa05bb4bbb1d0f6c37cdbbbd4a4e22d53cb7eef95a750def466` |
| 签名       | `Authenticode: NotSigned`；未使用商业证书或时间戳                                                                                                                                                                                                                                                 |
| 未验证边界 | 真实 Provider、打包 Tauri WebView + Keyring 冷启动、另一台电脑安装、192 次付费调用与 2,496 项人工评分；Novel Skill 保持 `KEEP_DISABLED`                                                                                                                                                           |

## v0.2.2 已发布历史记录（不可覆盖）

| 项目       | 已复核事实                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 来源       | PR #2 merged exact SHA；提交 `7dd746e7b35d07f9ae9605738d16dd852fd513a4`；annotated tag object `706b7d211f651e2a5eabdd738a79b93ff5ce10f0`                                                                                                                                                         |
| 远端门禁   | PR run `31500721439` 与 main run `31502928893` 的 quality、Windows native shell、Cloud PostgreSQL 三项均通过                                                                                                                                                                                     |
| Release    | <https://github.com/gugubugugu0826/InkShadow/releases/tag/v0.2.2>；`draft=false`、`prerelease=true`                                                                                                                                                                                              |
| 公开附件   | installer 7,458,168 bytes，SHA-256 `3048198c44bcb79ad240642ce81e698d499bfbf0bf443a62099d0a57ac5c128c`；manifest 9,989 bytes，SHA-256 `49752eb2cce9a4f73054d946605f25a25d64968e00f7aff64945d19b0a673f01`；`SHA256SUMS` SHA-256 `4aa1ce2b2bfd8e4268b3b815b9741da830a5775170fcd33beac44c1bea67bb80` |
| 未验证边界 | 真实 DeepSeek、192 次付费调用、2,496 项人工评分、Novel Skill 默认启用、真实 Tauri WebView 交互和另一台电脑安装；Novel Skill 保持 `KEEP_DISABLED`                                                                                                                                                 |

## 1. 永久规则

1. 公开仓库中的提交历史和 Release 资产都应视为已经公开传播。
2. 不得提交 API Key、密码、恢复码、数据库、用户正文、日志、诊断包、证书、签名私钥或
   服务账号文件。
3. 不得提交 `DESIGN/`、`installer/`、`archive/`、构建目录、依赖目录或本地测试产物。
4. 公开 Git 只跟踪根目录 `README.md`、`.gitignore` 中逐文件放行的 `docs/front-end/`、
   `docs/back-end/`、`docs/product-rebuild/`、三份发布所需 `docs/execution/` 文档和 GitHub
   发布指引。法律草案、安全运行手册、内部完成日志、原始评审材料与其他本地交付文档继续留在本机。
5. 删除最新提交中的秘密不能让秘密恢复安全。一旦误传，立即轮换或吊销凭据，再清理历史。
6. 不复用或强制移动任何已经发布的版本标签，也不静默替换其附件；后续修复使用新的补丁版本。
7. 未签名安装包只能标记为工程预览版或 Pre-release，不得描述为正式商业版本。
8. Release 必须对应一个已经推送、通过门禁且工作区干净的提交。
9. 本项目为 `UNLICENSED` 专有软件；公开可见不等于开源，不得在发布文案中暗示已经授予
   复制、修改、分发或商业使用权。

## 2. 两种操作不要混在一起

### 2.1 普通源码上传

只推送已经审核的源码变更，不创建版本标签，不上传安装包。

### 2.2 版本 Release

在普通源码上传完成、GitHub Actions 通过并完成候选安装包验证后，再创建不可变版本标签和
GitHub Release。

## 3. 开始前检查

在仓库根目录执行：

```powershell
git status --short
git branch --show-current
git remote -v
git diff --check
```

预期结果：

- 当前分支是计划发布的分支，通常为 `main`；
- `origin` 指向本仓库的 SSH 或 HTTPS 地址：`git@github.com:gugubugugu0826/InkShadow.git`
  或 `https://github.com/gugubugugu0826/InkShadow.git`；
- 没有意外的未跟踪文件、冲突标记或空白错误；
- 已确认工作区中原有的其他改动归属，不覆盖无关改动。

检查公开范围：

```powershell
git ls-files -- DESIGN installer archive
git ls-files -- docs
git ls-files "*.md"
git check-ignore -v docs/legal/PRIVACY_NOTICE_DRAFT.md docs/security/THREAT_MODEL.md DESIGN/.scope-check installer/.scope-check archive/.scope-check
git status --short --ignored docs DESIGN installer archive
```

预期结果：

- `git ls-files -- DESIGN installer archive` 没有输出；
- `git ls-files -- docs` 只包含 `.gitignore` 明确放行的公开文档；
- Markdown 跟踪列表中没有法律草案、安全运行手册、原始设计交付或本地评审材料；
- `DESIGN/`、`installer/`、`archive/` 和未放行的 `docs/` 文件显示为被 `.gitignore` 排除。

发布前还应人工检查本次差异：

```powershell
git diff --stat
git diff
git diff --cached --stat
git diff --cached
```

不要使用 `git add .` 后不看暂存内容就直接提交。

## 4. 版本号一致性

创建 Desktop Release 前，确保桌面产品版本号与标签一致。当前需要重点检查：

- `package.json`
- `apps/desktop/package.json`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/Cargo.lock` 中由 Cargo 更新的 InkShadow 包版本
- `apps/desktop/src/infrastructure/runtime.ts` 中非 Tauri 环境的诊断 fallback
- `apps/desktop/src/infrastructure/diagnostics.test.ts` 中对应的脱敏诊断断言

版本号使用不带 `v` 的语义版本。本轮桌面候选目标为 `0.2.17`；根清单、桌面清单、Tauri、Cargo、锁定文件、诊断回退版本和对应测试必须一致。全部适用本地自动化通过后，只能生成本指南约定的五项人工复测附件。当前指令不授权推送、标签、草稿或公开 GitHub Release。最新公开版本 `v0.2.16` 的标签、Release 和附件保持不可变；其精确来源提交以冻结的来源清单和公开 Release 为准。历史公开工程预发行 `v0.2.12` 固定解析到来源提交
`8d20dfbbdac1eaecdde046714ba257257cd68ace`。历史公开工程预发行 `v0.2.9` 固定解析到来源提交 `54d9647031bb97b4fc9f021d3b1acca7f6d25c47`，标签对象为
`8f68902b0d1be8dff3cabdb529d3adc0c74b44a3`。已发布的 `v0.2.6` 标签仍固定解析到
`b744d042eeafdd9db586388d71e701b1d937f366`，标签对象为
`f17fde56d83688bf6044a47c77794ebf0a46a936`。`0.2.0` / `v0.2.0`、
`0.2.1` / `v0.2.1`、`0.2.2` / `v0.2.2`、`0.2.3` / `v0.2.3`、`0.2.4` / `v0.2.4` 与
`0.2.5` / `v0.2.5`、`0.2.6` / `v0.2.6`、`0.2.7` / `v0.2.7`、`0.2.9` / `v0.2.9`、`0.2.12` / `v0.2.12` 与 `0.2.16` / `v0.2.16` 都是既有公开版本，
不能删除、移动或复用；`0.2.8` 是本地人工复测包而非公开标签。新的二进制修复必须继续使用新的
补丁版本。

```powershell
rg --no-ignore -n '"version"\s*:\s*"|^version\s*=' `
  package.json `
  apps/desktop/package.json `
  apps/desktop/src-tauri/Cargo.toml `
  apps/desktop/src-tauri/tauri.conf.json
```

`apps/web`、`apps/cloud-api` 和内部 workspace 包有独立的 `0.1.x` 版本线，不属于 Windows
桌面应用的公开发行附件，也不要求随桌面标签同步。文档提到“当前应用版本”时必须明确
指 Desktop，不能把这些内部包误写成同一可下载产品版本。

## 5. 源码上传前门禁

最低检查：

```powershell
pnpm install --frozen-lockfile
pnpm format:check
pnpm check:secrets
pnpm check:licenses
pnpm check:boundaries
pnpm check:desktop-release
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

上述最低检查通过后先完成文档并提交。正式 Windows 候选只能从已经提交且工作区干净的唯一
HEAD 重新生成；不要在打包后再提交会改变来源判定的代码或文档。

提交并确认 `git status --short` 为空后，再运行完整的一键候选链路：

```powershell
$env:CI = "true"
pnpm release:candidate:unsigned
Remove-Item Env:CI
```

如果 PowerShell 的执行策略阻止 `pnpm.ps1`，使用同名的 `pnpm.cmd`，不要为了发布临时放宽
系统执行策略。

该链路会先确认干净 HEAD 并记录完整 Commit SHA，再执行格式、秘密、许可证、架构边界、
发布配置、类型、Lint、Workspace 测试、Rust format/clippy/test、生产前端、Desktop Chromium
E2E 和未签名 NSIS 打包。正式前端清单还会再次核对 HEAD、工作区与源码指纹；任一步失败都
不得继续组装人工复测附件；本轮即使候选链通过，也不得据此创建标签或 Release。

以下验证不能被自动化测试结果替代：

- 最新安装包的安装、首次启动、覆盖升级、卸载保留和重装；
- 真实 Tauri WebView 下的中文输入、长文本、磁盘不足和强退恢复；
- 正式发布所需的 Authenticode 签名、时间戳和发布主体校验；
- 商业版本所需的法律、隐私、许可证和外部服务审批。

## 6. 提交与推送（0.2.17 远端步骤未授权）

0.2.17 只允许形成可追踪的本地候选提交，并从该提交构建人工复测附件。下述推送步骤是以后取得单独远端发布指令时的通用流程，不是本轮授权；当前任务必须在本地候选与清理完成后停止。

先按明确范围暂存：

```powershell
git add <明确的文件或目录>
git diff --cached --name-status
git diff --cached
```

再次确认暂存区没有：

- `.env`、凭据、证书和签名材料；
- 数据库、备份、用户内容、日志和诊断；
- 未列入公开清单的 `docs/` 文件、`DESIGN/`、`installer/`、`archive/`；
- `node_modules/`、`.pnpm-store/`、`target/`、`dist/`、安装包；
- 与本次任务无关的用户改动。

提交并复核；此时先不要上传旧构建：

```powershell
git commit -m "<清晰说明本次变化>"
git status --short
git rev-parse HEAD
```

工作区为空后，回到第 5 节执行完整候选链。只有另行取得明确推送授权且候选来源未变化后，才可推送同一 SHA：

```powershell
git push origin main
```

推送后在 GitHub Actions 中确认以下三个 Job 全部通过：

- `Type, lint, test and web build`
- `Cloud PostgreSQL and forced RLS`
- `Windows native shell`

Actions 尚未结束或失败时，不发布相同提交对应的 Release。

## 7. 候选安装包核对

未签名 NSIS 默认位于：

```text
apps/desktop/src-tauri/target/release/bundle/nsis/
```

定位并记录产物：

```powershell
$nsisRoot = (Resolve-Path `
  -LiteralPath "apps/desktop/src-tauri/target/release/bundle/nsis").Path
$installerPath = Join-Path `
  $nsisRoot `
  "墨影 InkShadow_0.2.17_x64-setup.exe"
$installers = @(Get-ChildItem `
  -LiteralPath $nsisRoot `
  -File `
  -Filter "*-setup.exe")
if ($installers.Count -ne 1 -or $installers[0].FullName -cne $installerPath) {
  throw "NSIS 目录必须恰好包含墨影 InkShadow_0.2.17_x64-setup.exe"
}
$installer = Get-Item -LiteralPath $installerPath

$installer | Select-Object FullName, Length, LastWriteTime
Get-FileHash -Algorithm SHA256 -LiteralPath $installer.FullName
Get-AuthenticodeSignature -LiteralPath $installer.FullName |
  Select-Object Status, StatusMessage, SignerCertificate, TimeStamperCertificate

$releaseManifest = Get-Content `
  -Raw `
  -Encoding utf8 `
  "apps/desktop/dist-release/inkshadow-release-manifest.json" |
  ConvertFrom-Json
$releaseManifest.gitCommitSha
git rev-parse HEAD
```

必须记录：

- 完整文件名；
- 字节数；
- SHA-256；
- 生成时间；
- 产品版本；
- Authenticode 状态；
- `inkshadow-release-manifest.json` 的完整 `gitCommitSha` 与当前 `HEAD` 完全一致；
- 对该二进制实际执行过的安装和运行验证。

签名或重新打包会改变字节内容，必须重新计算大小和 SHA-256。
建议把最终候选复制到 `archive/<日期>-<版本>/artifacts/` 或 `installer/<版本>/` 保存本地证据；
`archive/` 与 `installer/` 都不进入 Git，
而 GitHub Actions 中的临时候选 Artifact 不能作为永久档案。本轮只接受 Tauri 原始候选名
`墨影 InkShadow_0.2.17_x64-setup.exe`；不得改名后冒充新的构建，也不得按修改时间选择“最新”安装包。
本地候选目录必须恰好存在一个以 `-setup.exe` 结尾的原始构建文件。人工复测目录另行保存其字节完全相同的
`InkShadow_0.2.17_x64-setup.exe`，两者的大小和 SHA-256 必须先行核对一致。

这里要区分“仓库文件”“本地人工复测附件”和“GitHub 发布附件”：本地 `installer/` 文件夹永远不提交到源码仓库。本轮只组装“0.2.17 人工复测候选边界”列出的五个本地附件，不创建 GitHub 草稿，不生成发布说明，也不上传任何公开附件。

`pnpm release:candidate:unsigned` 只负责从唯一干净提交完成门禁、生成未签名安装程序，以及生成和核验
`apps/desktop/dist-release/inkshadow-release-manifest.json`；它不会按本轮交付名复制来源清单、生成完整验证报告、人工复测说明或 `SHA256SUMS.txt`，也不会组装最终五附件目录。不得把候选脚本成功误写成五项附件已经齐备。

五项本地人工复测附件在候选链成功后组装：

1. 将精确的 Tauri 中文名安装程序按原字节复制为 `InkShadow_0.2.17_x64-setup.exe`，与按本轮名称保存的来源清单一并放入新的 `installer/v0.2.17-manual-retest` 目录，并核对复制前后大小和 SHA-256 完全一致；
2. 将候选提交、来源指纹、门禁结果、未执行项和剩余风险写入 `InkShadow_0.2.17_VALIDATION_REPORT_zh-CN.md`，不得预填不存在的草稿或 Release 链接；
3. 生成 `InkShadow_0.2.17_MANUAL_RETEST_GUIDE_zh-CN.md`，列出编辑器、篇幅、提示词、资料编译、技能、事实、摘要、一致性和私密发送的准确人工步骤；
4. 对安装程序、来源清单、完整验证报告和人工复测说明计算 SHA-256，生成恰好四行的 `SHA256SUMS.txt`；
5. 确认目录恰好包含本指南规定的五个普通文件，没有旧安装包、临时文件或发布说明。`SHA256SUMS.txt` 自身的大小和 SHA-256 另行记录。

## 8. 创建版本标签（仅限以后单独授权）

0.2.17 人工复测候选不得执行本节。只有真实安装复测完成、版本号和发布范围重新确认，并取得单独标签授权后，才进入以下通用流程。

确认当前提交就是 Release 源码：

```powershell
git status --short
git rev-parse HEAD
git log -1 --oneline
```

创建并推送带说明的标签：

```powershell
git tag -a vX.Y.Z -m "InkShadow vX.Y.Z"
git show vX.Y.Z
git push origin vX.Y.Z
```

如果发现标签指向错误提交：

- 标签尚未公开时，停止并重新核对；
- 标签已经推送或 Release 已发布时，不强制覆盖原标签，改用新的补丁版本；
- 不执行 `git push --force` 修正公开版本历史。

## 9. 发布 GitHub Release（仅限以后单独授权）

0.2.17 人工复测候选不得执行本节，也不得先建草稿占位。以下只保留未来版本在取得单独发布指令后的通用核对方式；附件数量和名称必须来自那次发布指令，不能沿用本轮五项本地人工复测附件。

### 9.1 网页方式

1. 打开仓库的 **Releases**；
2. 选择 **Draft a new release**；
3. 选择该次发布指令明确授权且已经推送的 `vX.Y.Z` 标签，标题精确填写“墨影 InkShadow X.Y.Z”；
4. 不上传任何附件，先保存草稿并记录草稿 URL；此时正文只使用明确的临时占位说明；
5. 使用草稿 URL 和最终候选事实完成该次发布指令约定的附件与校验文件；
6. 用正式发布说明替换草稿正文；未签名状态写在正文中，并保持 **Set as a pre-release**；
7. 上传该次发布指令约定的附件，在草稿中确认数量、名称、大小、SHA-256 和来源提交全部一致；
8. 全部核验通过后才发布草稿；不得先公开不完整附件再补传；
9. 发布后重新打开 Release 页面，并将全部附件下载到全新目录复核。

### 9.2 GitHub CLI 方式

只有 `gh auth status` 确认当前账号有效时才使用：

```powershell
gh auth status
$releaseTag = "vX.Y.Z"
$releaseTitle = "墨影 InkShadow X.Y.Z"
gh release create $releaseTag `
  --repo gugubugugu0826/InkShadow `
  --title $releaseTitle `
  --notes "发布资料正在最终核验；草稿不得对外发布。" `
  --draft `
  --prerelease `
  --verify-tag

$draft = gh release view $releaseTag `
  --repo gugubugugu0826/InkShadow `
  --json url,isDraft,isPrerelease,targetCommitish,assets |
  ConvertFrom-Json
if (-not $draft.isDraft -or $draft.assets.Count -ne 0) {
  throw "初始 Release 必须是没有附件的草稿"
}
$draft.url

# 取得草稿 URL 后，完成该次发布指令约定的附件与校验，
# 并确认暂存目录恰好包含获准发布的文件。
gh release upload $releaseTag `
  $publicInstallerPath `
  $releaseManifestPath `
  $validationReportPath `
  $releaseNotesPath `
  $checksumPath `
  --repo gugubugugu0826/InkShadow

gh release edit $releaseTag `
  --repo gugubugugu0826/InkShadow `
  --title $releaseTitle `
  --notes-file $releaseNotesPath `
  --draft `
  --prerelease

gh release view $releaseTag `
  --repo gugubugugu0826/InkShadow `
  --json url,isDraft,isPrerelease,targetCommitish,assets

# 只有草稿附件数量、名称、大小、摘要和来源提交全部符合该次发布指令后才公开
gh release edit $releaseTag `
  --repo gugubugugu0826/InkShadow `
  --draft=false `
  --prerelease
```

`$publicInstallerPath` 必须是最终附件暂存目录中 ASCII 公开名安装程序的精确绝对路径，并已经与 Tauri 中文名原始候选完成字节数和 SHA-256 一致性核对，不得用“最新文件”推断；
`$validationReportPath` 和 `$releaseNotesPath` 必须分别指向取得草稿 URL 后生成的最终验证报告与正式发布说明。
正式发布说明是否同时作为附件上传，以该次单独发布指令为准。Release 标题始终精确为
“墨影 InkShadow X.Y.Z”；“未签名工程预览”等成熟度和签名说明只写入正文并通过预发行标志表达，
不得附加到标题。草稿核验失败时保持草稿并修复附件，不得公开残缺 Release。不要把访问令牌写入命令历史、仓库文件或发布说明。

任何 `VITE_*` 变量都应按可能进入前端构建和 WebView 的公开信息处理，禁止在其中存放秘密。
Windows Authenticode 私钥与安全更新清单使用的 Ed25519 私钥也必须分离保管。

## 10. Release 说明必须包含（仅限以后单独授权）

建议按以下顺序书写：

1. 本版本定位：工程预览、Beta 或正式版本；
2. 主要新增和修复；
3. 本次实际通过的测试与安装验证；
4. 安装包文件名、字节数和 SHA-256；
5. 支持的操作系统和架构；
6. 是否完成代码签名；
7. 数据迁移、备份和回滚提示；
8. 尚未完成的云服务、同步、更新或商业能力；
9. 已知风险，以及不得用于唯一副本或敏感生产数据等限制。

不得把计划中的能力写成已经可用，也不得把“代码存在”写成“生产验证通过”。

## 11. 发布后验证（仅限以后单独授权）

发布完成后核对：

```powershell
git ls-remote --heads origin main
git ls-remote --tags origin vX.Y.Z
```

在 GitHub 页面确认：

- 仓库仍为 Public；
- 默认分支和提交正确；
- Release 不是 Draft；
- Pre-release/正式版标识符合实际门禁；
- 标签指向预期提交；
- 公开附件与该次单独发布指令约定一致，名称、大小和下载状态正确；
- GitHub 自动生成的 Source code 只含被 Git 跟踪的文件；
- Release 说明中的 SHA-256 与本地文件一致；
- 把该次发布指令约定的全部附件下载到全新目录并逐一重新计算 SHA-256；用下载后的校验文件复核其明确覆盖的附件；
- 将下载后的校验文件自身大小和 SHA-256 与 Release 页面及最终报告中的独立记录比对，避免循环哈希；清单中的源码提交仍须等于标签解析结果。

如果发布后发现一般说明错误，可以修订 Release 文案；如果二进制、源码或迁移有误，使用新
补丁版本重新发布，不要静默替换同版本资产。

## 12. 异常处理

### 12.1 误传凭据

1. 立即吊销或轮换；
2. 停止继续发布；
3. 记录暴露范围和时间；
4. 使用经过批准的历史清理流程移除；
5. 通知已克隆仓库的相关人员；
6. 重新运行秘密扫描；
7. 不把“历史已清理”当作原凭据仍然安全。

### 12.2 CI 失败

保留失败日志和复现信息，修复后创建新提交。不要跳过失败 Job，也不要用本地一次通过替代
GitHub 上的失败结果。

### 12.3 安装包有误

对错误 Release 标明撤回或删除错误资产，并使用新补丁版本重新构建、重新验证和重新发布。
不要给同一版本号上传内容不同但名称相同的安装包。

删除 Release、远程标签或远程资产属于外部不可逆操作，实际执行前必须单独确认。已推送到
公共 `main` 的普通代码错误优先使用 `git revert <commit>`，不要强推或重写历史。

### 12.4 需要正式商业发布

暂停发布并先取得：

- 有权使用的 Windows 发布主体和代码签名证书；
- 正式时间戳服务；
- 法律、隐私、EULA 和第三方许可审批；
- 生产域名、更新通道及独立签名密钥托管；
- 最新候选的完整安装、升级、卸载和恢复验收证据。

## 13. 发布前后一页清单

本清单是以后取得单独发布授权时的通用清单。0.2.17 本轮只执行候选生成、五项本地附件核对和可再生资源清理，不勾选推送、远端持续集成、标签、Release 或回下载项目。

- [ ] 当前分支、远端和提交正确
- [ ] 工作区和暂存区已经逐文件审查
- [ ] `docs/` 只包含经审查的公开文档；`DESIGN/`、`installer/`、`archive/` 未被 Git 跟踪
- [ ] 没有凭据、数据库、用户内容、日志和构建产物
- [ ] 版本号与标签一致
- [ ] `pnpm release:candidate:unsigned` 通过
- [ ] 最新候选完成适用的安装与运行验证
- [ ] 大小、SHA-256、签名状态已记录
- [ ] 源码已经推送
- [ ] GitHub Actions 三个 Job 全部通过
- [ ] 标签指向正确且没有被重写
- [ ] Release 文案没有夸大未完成能力
- [ ] 未签名版本标为 Pre-release
- [ ] GitHub 附件数量和名称符合该次单独发布指令，且全部附件均来自同一发布提交
- [ ] 全部附件回下载后的大小和 SHA-256 均复核通过；校验文件覆盖范围、其自身独立摘要及清单源码提交均复核通过
- [ ] Release 页面、直接下载链接和回滚说明可用

## 14. `v0.2.x` 不可省略的真实性边界

- 没有用户提供的真实 API Key、计费账户和供应商可用配额时，只能写“本地/模拟协议测试通过”，不能写“真实 OpenAI、DeepSeek、百炼、豆包、Gemini 或 Claude 已验收”。
- 百炼/Qwen 远程 Rerank 已有受控 `/reranks` 代码路径，但在真实 Qwen Key 线上端到端通过前，Release 说明必须保留该限制。
- 没有百万字级项目的召回、上下文压缩、延迟、内存和费用数据时，不得宣称长篇性能已经验证。
- 没有对本次最终二进制逐项完成安装、首次启动、旧版本升级、卸载保留、重装、数据库迁移和恢复，就不得把源码测试或旧安装包结果写成本次安装包验收。
- 没有 Authenticode 证书、时间戳和商业授权/法律审批时，`v0.2.x` 必须继续标为工程预览版或 Pre-release。
