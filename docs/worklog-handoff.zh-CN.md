# PiHub 0.0.1 工作记录与交接说明

> 文档版本：`0.0.1`
>
> 记录日期：2026-08-19
>
> 适用范围：本轮代码审计、功能补全、安全加固、插件安装链、UI 验证和发布准备

这份文档是维护者接手本项目时的事实基线。它同时记录已经落到源码并经过本地验证的内容、尚未具备正式发布证据的内容，以及下一次操作的建议顺序。文档不包含设备地址、凭据、Token、私钥或本机绝对路径。

## 1. 当前结论

PiHub 已完成一轮以 `0.0.1` 为目标的代码级审计和实现收敛：桌面端、Tauri bootstrap、Server、固定插件 bundle、鉴权、文件/Git/PTY、更新验签和隐私门禁均已补强。远程 SSH 安装现在支持选择插件，也支持对已有设备“仅安装 Server”；`pi-magic-context` 的 todowrite 已强制关闭，`pi-todo-rail` 作为唯一活动待办 UI；`AGENTS.md` 只在不存在或去除空白后为空时注入。

当前仍不能称为“正式公开发布完成”：

- 工作区存在本轮未提交修改，尚未形成最终干净提交和不可变 `v0.0.1` tag。
- GitHub 仓库地址已配置为 `yourChainGod/pihub`，但本轮没有推送修改，也没有触发 GitHub Actions，以避免消耗额度。
- macOS、Windows、Linux 的原生安装、升级、回滚、开机自启和卸载尚未在真实 runner 上全部验收。
- Apple 公证、Windows Authenticode、Tauri updater 私钥、Server Ed25519 私钥和正式 GitHub Release 尚未形成可复核证据。
- `/Applications/PiHub.app` 若仍存在，只是旧的 `0.2.1` 构建，不能作为 `0.0.1` 验收依据。

## 2. 目标与决策记录

### 2.1 本轮目标

1. 读通桌面端、Tauri、Server、安装器、插件 bundle、鉴权和发布链路。
2. 在不引入任意远程 npm 安装的前提下，完善远程部署和插件选择。
3. 让 Magic Context 与 Todo Rail 分工明确，避免两个待办系统重复渲染。
4. 对 `AGENTS.md` 进行保守注入，绝不覆盖用户已有规则。
5. 保持 macOS、Windows、Linux 的服务端路径、服务管理和终端后端边界清晰。
6. 固定 GitHub 签名 Release 更新来源，建立隐私和安全发布门禁。
7. 将版本统一到 `0.0.1`，补齐中文用户和维护文档。

### 2.2 已确定的工程决策

| 决策 | 原因与影响 |
| --- | --- |
| 插件使用固定名称、固定版本、固定 bundle | 防止客户端或远端请求任意 npm 包；安装源、依赖和资源布局可审计。 |
| 插件选择只允许 allowlist 内的精确版本 | 选择结果会在 bootstrap、Server preference 和 bundle provisioning 三处再次校验。 |
| “仅安装 Server”传递空插件集合 | 已配置设备可以只修复/更新 Server，不触碰已有受管插件配置。 |
| Magic Context 关闭 `todowrite` 和 `overlay` | Todo Rail 负责活动待办，Magic Context 负责长期上下文，减少重复 UI 和状态冲突。 |
| 非空 `AGENTS.md` 完全跳过 | 用户规则优先；PiHub 不追加、覆盖、合并或重排用户已有内容。 |
| 动态插件/技能安装、更新、删除 fail-closed | 在不可变签名 catalog 完成前，拒绝任意动态包操作。 |
| Server 只监听回环地址 | 外部入口统一经过 Tailscale Serve HTTPS，避免 Server 直接暴露在局域网或公网。 |
| 更新固定到 GitHub 签名 Release | 清单、资产、大小、SHA-256、通道、版本和候选健康状态全部校验，失败回滚。 |
| `0.0.1` 使用独立桌面身份 | 不把新产品误当作旧 `0.2.1` 的原地降级或覆盖安装。 |
| 本轮不推送、不跑 Actions | 避免在未完成隐私复核和原生签名准备前消耗 GitHub Actions 额度。 |

## 3. 架构与目录地图

```text
PiHub Desktop (React)
  src/App.tsx                 首页、设备发现、部署、插件选择、更新入口
  src/DeviceSetup.tsx         设备状态、插件状态、Magic Context 证明、更新 UI
  src/lib.ts                  Tauri invoke、远程请求、bootstrap 参数桥接
  src/styles.css              桌面 UI、表单、状态、无障碍和响应式样式
        |
        v
Tauri / Rust
  src-tauri/src/lib.rs        命令边界、目标校验、凭据库和进程调用
  src-tauri/src/standalone_bootstrap.mjs
                              发布资产验签、解包、候选健康检查、服务切换
  src-tauri/src/bootstrap_unix.sh
                              macOS/Linux 的短期引导和 Node 校验/准备
  src-tauri/src/bootstrap_windows.ps1
                              Windows OpenSSH 下的 PowerShell 引导
        |
        v
PiHub Server
  server/app/api/             Next.js API、鉴权和资源路由
  server/lib/default-extensions.ts
                              固定插件、配置、AGENTS 注入和事务回滚
  server/bin/server-supervisor.js
                              Server 更新、重启、健康检查和 known-good 回滚
  server/docs/                Server 安全、ADR、发布和运行说明
        |
        v
Pi Agent / workspace / Git / PTY / Provider

构建与发布
  scripts/default-extension-bundle.mjs
                              固定插件 bundle、清单、锁定依赖和隐私检查
  scripts/secure-npm-environment.mjs
                              发布/构建时的最小凭据环境
  .github/workflows/release.yml
                              原生 runner 发布流程（本轮未触发）
```

桌面端本地渲染工作台；Server 根页面只显示运行状态。Server 监听 `127.0.0.1:30141`，远程访问由 Tailscale Serve 提供 HTTPS。Windows 使用 OpenSSH 做首次部署、ConPTY 做在线终端；macOS/Linux 使用 Tailscale SSH 和系统 PTY。

## 4. 远程安装与插件选择

### 4.1 完整流程

1. 桌面端读取 Tailscale 状态，发现 Tailnet 设备或接受经过校验的手动地址。
2. 用户在设备配置页选择目标平台、用户名、安装内容和插件。
3. Tauri 只向目标发送短期 bootstrap 参数，不把 Server 压缩包内嵌到桌面应用。
4. bootstrap 从固定 GitHub Release 获取 Server manifest，校验签名、版本、平台、架构、重定向、大小、SHA-256、归档结构和候选健康状态。
5. Unix 引导在缺少兼容 Node.js 时下载固定版本并校验 SHA-256；Windows 要求用户预装 Node.js `22.19.0` 或更高版本。
6. Server 安装到平台数据根，注册当前用户的后台服务，并启用或检查 Tailscale Serve。
7. 只有用户明确选择插件时才执行 bundle provisioning；Server 启动后再次校验选择，并返回实际安装状态。
8. 桌面端刷新设备状态，显示 Server 版本、插件来源、每个插件的安装状态和 Magic Context 配置证明。

### 4.2 固定插件清单

| 包名 | 版本 | 职责 |
| --- | --- | --- |
| `@cortexkit/pi-magic-context` | `0.38.0` | 持久上下文、压缩记忆、私有权限和 fail-closed |
| `pi-todo-rail` | `0.2.3` | 当前项目/会话的活动待办栏 |
| `@ff-labs/pi-fff` | `0.10.5` | 快速文件搜索 |
| `pi-simplify` | `0.2.3` | 常用 Pi 工作流简化 |
| `@gotgenes/pi-permission-system` | `26.3.0` | 命令、路径和外部目录权限审查 |
| `@eko24ive/pi-ask` | `1.2.0` | 交互式确认和提问；包含 skills 目录 |
| `@gotgenes/pi-subagents` | `19.3.2` | 受控子代理工具 |

清单同时维护在 `extensions/package.json`、`scripts/default-extension-bundle.mjs`、`server/lib/default-extensions.ts` 和 bootstrap 模板中。修改时必须同步名称、版本、资源布局、peer 兼容性和测试 fixture。

### 4.3 UI 行为

- 默认全选 7 个插件。
- 每个插件使用 checkbox，可以逐项取消。
- “仅安装 Server”会隐藏插件选择，并传递空数组。
- Server-only 不调用插件 provisioning，因此保留目标机已有插件文件和 Pi 配置；它只安装/验证 Server 及其服务链。
- 设备设置页只读显示签名 bundle 来源和实际安装计数，不把客户端勾选结果当作安装成功证明。
- Server 端拒绝不在固定清单中的名称、版本、重复项、未知字段和不规范 JSON。

## 5. Magic Context、Todo Rail 与 `AGENTS.md`

### 5.1 Magic Context 强制配置

选择 Magic Context 后，Server 会保留用户已有合法 JSONC 配置，并强制写入以下安全不变量：

```json
{
  "enabled": true,
  "compaction": { "enabled": true },
  "todowrite": { "enabled": false, "overlay": false },
  "storage": { "enforce_private_permissions": true },
  "fail_closed_blocking": true
}
```

实际实现允许保留其他用户配置字段，但遇到非法 JSONC、重复/异常结构或超出边界时拒绝写入并回滚。设备设置页会显示 compaction 状态和 todowrite 已禁用证明。

### 5.2 Todo Rail 职责

Todo Rail 是活动任务的唯一 UI。Magic Context 的 todowrite 功能保持关闭；不要在后续改动中为了“恢复待办”而重新打开 `todowrite.enabled` 或 `todowrite.overlay`。

### 5.3 `AGENTS.md` 注入规则

只有以下情况允许写入 PiHub 管理块：

- `AGENTS.md` 不存在；或
- 文件存在，但 `trim()` 后为空。

只要文件包含任何非空内容，即使内容来自旧的 PiHub 管理块，也完全跳过。不会追加、覆盖、合并、格式化或修改用户规则。注入块会提醒长期上下文与活动待办的职责边界，并禁止把凭据、私有主机名、用户名和机器绝对路径放入共享上下文。

相关实现和测试：`server/lib/default-extensions.ts`、`server/lib/default-extensions.test.mjs`、`server/app/api/pihub/setup/route.test.mjs`。

## 6. 安全与隐私边界

### 6.1 已落实的不变量

- 除 `GET /api/health` 和一次性 `POST /api/pairing/claim` 外，API 默认需要设备身份和 capability。
- 请求签名覆盖 method、target、timestamp、nonce、鉴权 epoch 和 raw body SHA-256；服务端检查时钟窗口和重放。
- 设备密钥存入操作系统凭据库，不写入 `devices.json`；Provider 凭据留在远端 Pi Agent 数据目录。
- 工作区根、规范路径、会话 owner、Git worktree、PTY、Provider、Plugin 和 Skill 在 Server 端二次校验。
- 外联只允许固定来源或共享安全 transport；禁止 caller-selected redirect、私网地址、DNS rebinding、无界响应和凭据跨源转发。
- 文件、上传、SSE、PTY、子进程和临时文件都有大小、时间或取消边界；失败时不保留可见半成品。
- 动态 plugin/skill 的安装、更新、删除在签名 catalog 完成前固定拒绝，避免任意包执行。
- 发布 manifest、asset、checksum、SBOM 和 provenance 必须绑定同一不可变 tag commit；任一验签失败即停止。
- release npm、Next build、扩展 loader、Server runtime 和服务安装器使用最小环境，避免凭据进入 argv、日志、错误、快照或附件。

### 6.2 数据边界

桌面端可能处理设备地址、项目路径、会话正文、终端输出、模型设置和设备状态；服务端可能处理 Pi Agent 数据、Provider 凭据、鉴权状态、工作区文件和更新日志。文档、Issue、测试 fixture 和发布附件不得包含真实设备信息或密钥。

解除配对只删除当前桌面端的设备密钥，不会自动吊销远端身份。彻底撤销时必须使用受信任设备或 `pihub-auth-admin revoke` 吊销对应 device id；卸载服务也不会自动删除 Pi 数据、凭据、鉴权状态或日志。

残余风险仍包括真实平台文件系统上的 TOCTOU/mount 场景、操作系统账户隔离、磁盘加密、Tailnet ACL 和备份策略。这些需要在原生机器和正式发布门禁中继续验证，不能只靠单元测试声称消除。

## 7. UI、图标与可用性记录

- 远程安装内容以紧凑 checkbox 网格呈现，Server-only 作为独立开关。
- 设备设置页显示 Server、插件计数、签名来源和 Magic Context 证明。
- 更新 UI 区分检查、下载、验签、安装、重启、成功、失败和回滚状态；有运行中的 Agent session 时默认拒绝更新，强制更新需要用户确认。
- 已覆盖 loading、empty、error、retry、confirm、offline、更新和资源管理状态，并处理键盘、减少动态效果、强制高对比和 Axe 检查。
- 图标中心改为 π / pi 标记，源图和各平台 PNG、ICO、ICNS、Windows、Android/iOS 资产已重新生成；`scripts/verify-icon-assets.mjs` 检查 53 个资产及 π 标记。
- 正式安装包中的 Dock、任务栏、启动器和安装器图标仍需在三种原生系统上人工验收。

## 8. 版本、GitHub 更新与发布策略

### 8.1 当前版本身份

- Desktop 和 Server 配置统一为 `0.0.1`。
- 桌面产品名为 `PiHub Desktop`，bundle identifier 为 `io.github.yourchaingod.pihub.desktop`。
- 新桌面身份与旧 `PiHub 0.2.1` 的配置、WebView 存储、更新状态和系统凭据隔离，不是原地降级包。

### 8.2 自动更新信任链

- Desktop 读取固定仓库稳定 Release 的 `pihub-desktop-v1.json` 与 `.sig`，要求 `channel: desktop-v1-stable`。
- Server 读取同一固定仓库的 `release-manifest.json`，要求 `channel: stable`，资产 URL 指向不可变 `v<version>` Release。
- 两条链都校验 Ed25519 签名、版本、平台/架构、大小、SHA-256、文件结构和来源；Server 还会在切换前后做健康检查并恢复 known-good 版本。
- 正式更新资产必须匿名可读，因为客户端不携带 GitHub Token；私有源码仓库不能直接作为客户端更新源。

### 8.3 本轮 GitHub 状态

- `origin` 已指向 `https://github.com/yourChainGod/pihub.git`。
- 本轮未推送任何修改、未创建正式 Release、未创建不可变 `v0.0.1` tag。
- 本轮不触发 GitHub Actions。后续获得发布确认后，应先在最终提交上重新做隐私扫描，再按 `docs/release.md` 配置受保护 Tag、Environment、签名 secret、审批人和只读默认 Actions 权限。
- 不要把签名私钥放入仓库、Artifact、缓存、日志或普通 Repository secret；私钥只进入受保护的 signing Environment。

## 9. 验证记录

以下结果来自本轮源码快照，后续任何代码修改后都必须重跑对应门禁。数量是记录时的实际结果，最终以退出码、零失败和零 skip 为准。

| 范围 | 结果 |
| --- | --- |
| Server 全量测试 | `801 passed / 0 failed` |
| Playwright Chromium / Firefox / WebKit | `153 passed` |
| 发布脚本测试 | `89 passed` |
| 根单元测试 | `3 passed` |
| Rust 测试 | `55 passed / 1 ignored` |
| 根构建、Server build、TypeScript、根/Server ESLint | 通过 |
| Rust fmt / clippy | 通过 |
| 隐私扫描 | `495 tracked files`，`0 errors / 0 warnings` |
| 图标资产验证 | `53` 个资产通过，π 标记检查通过 |
| 生产依赖 audit | 根与 Server 均无高等级漏洞报告 |
| GitHub Actions | 本轮未触发 |

建议的完整本地门禁：

```bash
npm ci
npm run lint
npm exec -- tsc --noEmit --pretty false
npm run test:unit
npm run build
npm exec -- playwright test

npm --prefix server ci
npm --prefix server run lint
npm --prefix server exec -- tsc --noEmit --pretty false
npm --prefix server test
npm --prefix server run build

node --test scripts/*.test.mjs
node scripts/check-release-config.mjs
node scripts/privacy-scan.mjs --fail-on-warnings
npm audit --omit=dev --audit-level=high
npm --prefix server audit --omit=dev --audit-level=high

cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features

git diff --check
```

## 10. 已知限制与未关闭事项

| 优先级 | 事项 | 关闭条件 |
| --- | --- | --- |
| P0 | 最终工作树和 Git 历史未形成发布提交 | 并行修改停止、隐私扫描通过、提交内容可复核、历史无凭据。 |
| P0 | 三平台原生 runner 未完成真实安装链 | macOS/Windows/Linux arm64/x64 完成安装、状态、repair、logs、update、rollback、uninstall 和开机自启。 |
| P0 | 签名、公证和正式 Release 未完成 | 形成受保护 Environment、签名资产、SBOM/provenance、匿名回读和人工审批证据。 |
| P0 | GitHub 仓库规则尚无最终可验证状态 | 配置 tag ruleset、Actions 权限、Dependabot、CodeQL、secret scanning、push protection 和分支保护。 |
| P1 | Windows OpenSSH、ConPTY 和系统服务受宿主策略影响 | 在真实 Windows 用户账户、非管理员日常运行权限和重启后场景中复验。 |
| P1 | 文件系统 TOCTOU/mount 风险 | 在真实 mount、符号链接、并发移动和权限变化场景中完成安全验证。 |
| P1 | 图标尚未随正式安装器验收 | 从最终 DMG、NSIS、AppImage/deb 验证 Dock/任务栏/启动器展示和尺寸。 |
| P2 | 没有动态插件市场 | 继续维持 `signed_catalog_required`，除非另行设计不可变 catalog、签名和回滚协议。 |

## 11. 下一位维护者的执行顺序

1. 读取本文件、`README.md`、`docs/audit-0.0.1.md`、`docs/privacy-audit.md`、`docs/release.md`、`server/README.md` 和 `SECURITY.md`。
2. 执行 `git status --short`、`git diff --check`，确认没有混入构建输出、真实设备信息或密钥；不要使用破坏性 Git 命令覆盖现有修改。
3. 在当前最终快照重新执行隐私扫描、根/Server 测试、Playwright、Rust 门禁和 release config 检查。
4. 审阅 `extensions/package.json`、`scripts/default-extension-bundle.mjs`、`server/lib/default-extensions.ts`、bootstrap 模板和相关 fixture，确认七个插件名称、版本和资源布局一致。
5. 做一次真实桌面 UI 回归：完整插件选择、取消部分插件、Server-only、已有 `AGENTS.md` 非空、空文件和不存在文件、Magic Context/Todo Rail 状态。
6. 在 macOS、Windows、Linux 原生机器完成安装/服务/终端/更新/回滚/卸载证据；Windows 先按 `docs/windows.md` 配置 OpenSSH。
7. 只有 P0 事项关闭后，才创建受保护 `v0.0.1` tag、运行必要的 GitHub Actions，并在 draft Release 上做独立资产复核。
8. 正式发布前再次执行完整历史的 privacy、Gitleaks、SBOM、provenance、CodeQL 和依赖审计；任何 warning 都停止发布。
9. 发布后用匿名客户端路径完成 Desktop 和 Server 的下载、验签、候选健康检查、切换、重启恢复和回滚演练，并把证据链接回本文件或 `docs/audit-0.0.1.md`。

## 12. 关键文件索引

- 用户入口和安装选择：`src/App.tsx`、`src/DeviceSetup.tsx`、`src/lib.ts`、`src/types.ts`
- Server 插件与配置事务：`server/lib/default-extensions.ts`
- Server 安装状态 API：`server/app/api/pihub/setup/route.ts`
- Server 重启/更新：`server/bin/server-supervisor.js`
- Tauri bootstrap：`src-tauri/src/standalone_bootstrap.mjs`、`src-tauri/src/bootstrap_unix.sh`、`src-tauri/src/bootstrap_windows.ps1`
- 固定插件 bundle：`extensions/package.json`、`scripts/default-extension-bundle.mjs`、`scripts/default-extension-test-fixture.mjs`
- 安全环境和隐私门禁：`scripts/secure-npm-environment.mjs`、`scripts/privacy-scan.mjs`、`docs/privacy-audit.md`
- 发布与更新：`.github/workflows/release.yml`、`docs/release.md`、`server/docs/release.md`
- 审计结论：`docs/audit-0.0.1.md`
- 图标：`src-tauri/icons/app-icon.svg`、`src-tauri/icons/`、`scripts/verify-icon-assets.mjs`

## 13. 交接原则

后续修改必须优先保持四个边界：插件来源可验证、用户配置不可被静默覆盖、远端访问只走受信任 Tailnet/签名链、失败操作可回滚。若新需求与这四个边界冲突，应先更新 ADR、测试和发布门禁，再改实现；不要通过放宽 allowlist、恢复匿名接口、写入凭据或跳过验签来“临时解决”。
