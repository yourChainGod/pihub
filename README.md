# PiHub

PiHub 是一个面向 [Pi Coding Agent](https://github.com/earendil-works/pi) 的私有多设备桌面工作台。桌面端使用 React + Tauri 构建，通过 Tailscale 私网连接运行在各节点上的 PiHub Server；会话、项目文件、Git 状态、终端和模型凭据始终保存在对应节点，不经过任何中心云服务。

当前 Server 版本：`0.0.5`。项目仍处于早期阶段，建议先在可恢复的开发环境中使用。

## 功能

- 从本机 Tailscale 状态发现设备，或手动添加 `.ts.net`、Tailscale CGNAT/IPv6 地址。
- 每台设备使用独立原生窗口，支持多项目、多会话、流式消息、停止与继续生成。
- 消息支持逐条复制与代码块复制；输入框可用 `@` 引用工作区文件，文件面板右键也可直接插入引用。
- 扩展面板原生集成：待办栏（Todo Rail，输入框上方、可折叠、只读反映插件状态）、权限规则胶囊（可增删 PiHub 规则）、子代理进度轮询面板，以及 pi-ask 的原生问询面板（替代 TUI 字符画，经扩展事件总线桥接结构化数据）。
- 每个 Agent 会话运行在独立的子进程中（默认开启），扩展的进程级单例假设互不干扰。
- 浏览、编辑、上传、移动和删除已授权工作区内的文件。
- 查看 Git 状态与 diff，创建、切换和移除 Git worktree。
- 使用真实 PTY 终端：Unix 使用本机 shell，Windows 使用 ConPTY。
- 管理模型、Provider 凭据、插件、技能和项目信任。
- 远程部署：桌面端「配置设备」经 SSH 发送短期 bootstrap，目标节点验签下载并事务安装 Server；也可用仓库自带的 CLI 一键脚本（见下文）。
- 桌面端和 Server 均从 GitHub 获取签名更新；Server 更新支持候选健康检查和事务回滚。

PiHub 不嵌入远端网页。设备窗口中的界面由桌面端本地渲染，Tauri 的 Rust 层负责校验目标、签名请求并与远端 API 通信。

## 架构

```text
PiHub Desktop
  React UI
      |
  Tauri / Rust transport
      |  HTTPS + PiHub-HMAC-SHA256
      |  only through the Tailnet
      v
Tailscale Serve :30141
      |
      v
PiHub Server 127.0.0.1:30141
  Next.js API + stable supervisor
      |
      +-- Pi Agent / sessions（每会话一个子进程）/ models
      +-- authorized workspace / Git
      +-- node-pty / ConPTY
```

Server 根页面只显示运行状态；完整工作台仅存在于桌面客户端。Server 实现和维护说明见 [`server/README.md`](server/README.md)。

## 平台支持

| 部分 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 桌面安装包 | Universal DMG | x64 NSIS | x64 AppImage、deb |
| Server 发布包 | arm64、x64 | arm64、x64 | arm64、x64 |
| 后台服务 | LaunchAgent | 当前用户计划任务 | systemd user service |
| 首次远程部署 | Tailscale SSH | Windows OpenSSH | Tailscale SSH |
| 在线终端 | PTY | ConPTY | PTY |

桌面安装包和 Server 发布包的架构范围不同，请按目标机器选择资产。

## 安装与首次连接

### 1. 安装桌面端

从 [GitHub Releases](https://github.com/yourChainGod/pihub/releases) 下载 `PiHub-Desktop_*` 对应系统的安装包。发布资产应带有平台签名；来源或签名无法确认时不要继续安装。桌面产品名为 `PiHub Desktop`，bundle identifier 为 `io.github.yourchaingod.pihub.desktop`。

桌面机和目标节点都需要安装并登录 Tailscale，且位于同一 Tailnet。PiHub 不支持 Tailscale Funnel，也不把普通局域网或公网地址作为回退路径。

### 2. 部署目标节点

方式一（桌面端）：在 PiHub 首页选择「配置设备」，然后选择 Tailnet 节点。macOS/Linux 目标需启用 Tailscale SSH；Windows 目标需先配置好 OpenSSH Server 和 Node.js `22.19.0+`。

方式二（CLI，适合批量或无人值守）：

```bash
node scripts/ssh-deploy.mjs <节点名> --check                 # 只探测远端，不改动
node scripts/ssh-deploy.mjs <节点名> --allow-root --yes      # 安装或升级
```

脚本会先探测远端平台、Node、现有安装版本、旧版服务冲突和 Tailscale Serve 状态，再从 `release-artifacts/` 按平台自动选择最新发布包（校验 `.sha256`），经 SSH 直传并执行与桌面端完全相同的事务式 bootstrap（健康检查、失败回滚）。同版本重装或降级默认被拒绝（`--force` 放行）；更多选项见 `--help`。

两种方式的 bootstrap 都只从固定的 `yourChainGod/pihub` GitHub Release 读取 Ed25519 签名清单（或校验本地预签名包），按平台选择独立资产，并校验重定向目标、大小、SHA-256、资产签名、归档结构、精确版本和候选健康状态。部署完成后，PiHub Server 只监听 `127.0.0.1:30141`，远程入口由 Tailscale Serve 提供 HTTPS。

### Server 与插件选择

「SSH 一键安装」会先安装经过签名校验的 PiHub Server，然后显示同一签名 bundle 中的固定插件清单。插件不会从远端请求任意 npm 包，也没有在线安装或更新入口；每次选择都会在服务端再次按名称和精确版本校验。

| 插件 | 固定版本 | 职责 |
| --- | --- | --- |
| `@cortexkit/pi-magic-context` | `0.38.0` | 持久上下文、压缩记忆与私有权限约束 |
| `pi-todo-rail` | `0.2.3` | 当前项目和会话的待办栏 |
| `@ff-labs/pi-fff` | `0.10.5` | 快速文件搜索 |
| `pi-simplify` | `0.2.3` | 常用 Pi 工作流简化 |
| `@gotgenes/pi-permission-system` | `26.3.0` | 命令与路径权限审查 |
| `@eko24ive/pi-ask` | `1.2.0` | 交互式确认与提问 |
| `@gotgenes/pi-subagents` | `19.3.2` | 受控子代理工具 |

默认状态为全选；取消勾选只保留所选 facade。已配置好的设备可以勾选「仅安装 Server」，这会传递空插件集合，不改写或启用任何受管插件配置。设备设置页只读显示服务端实际安装状态和来源。

Magic Context 与 Todo Rail 的职责是分开的：Todo Rail 负责活动待办，Magic Context 负责长期上下文。PiHub 强制写入 Magic Context 的安全配置，开启 compaction、私有权限和 fail-closed，并始终将 `todowrite.enabled` 与 `todowrite.overlay` 设为 `false`，避免两个待办系统重复呈现。

远端 Pi Agent 目录中的 `AGENTS.md` 只有在文件不存在或内容去除空白后为空时才注入 PiHub 管理块；已有任何非空内容（包括用户规则）都会按字节保持不变，不追加、不覆盖、不合并。

### 3. 配对

部署与配对是两个独立步骤。首次配对必须在目标节点本机生成一次性配对码；后续可由带有 `devices:manage` 权限的已配对设备签发或吊销设备。

```bash
node "<当前 Server 版本目录>/bin/pihub-auth-admin.js" issue \
  --input pairing-request.json \
  --output pairing-grant.json
```

输入文件必须明确列出权限，输出文件包含短时有效、仅可使用一次的配对码。不要把配对码放入命令行参数、环境变量、Issue、聊天记录或日志。完整的安全示例和权限列表见 [`server/README.md`](server/README.md)。

在 PiHub 设备菜单中选择「配对」，输入 `pihub-...` 配对码。成功后，设备密钥写入操作系统凭据库，不写入 `devices.json`。

## 安全边界

- Server 强制监听回环地址；远程访问限定为 Tailscale Serve HTTPS。
- 客户端只接受 `.ts.net`、`100.64.0.0/10` 和 Tailscale IPv6 地址，并拒绝 URL 凭据、附加路径/查询/片段和非 HTTPS 入口。
- 除 `GET /api/health` 和一次性 `POST /api/pairing/claim` 外，API 默认需要设备身份。
- 每个受保护请求使用 `pihub-request-v3` 上下文签名，覆盖方法、目标、时间戳、随机 nonce、鉴权 epoch 和请求体 SHA-256；服务端检查时钟窗口和重放。
- 设备权限按 capability 最小授权；会话拥有者、工作区根、规范路径和项目信任在服务端再次校验。
- Provider 凭据保存在远端 Pi Agent 数据目录；桌面端不会把 Provider 密钥保存到设备清单。
- 会话正文仅在桌面进程内存中做有界缓存。
- 更新包必须通过固定信任根、签名、大小与 SHA-256 校验；验证失败不会进入安装阶段。

安全报告方式见 [`SECURITY.md`](SECURITY.md)。这些约束不能替代 Tailnet ACL、操作系统账户隔离、磁盘加密和可靠备份。

## 数据、解除配对与卸载

PiHub 会处理设备地址、项目路径、会话内容、终端输出、模型凭据和更新日志。主要数据边界如下：

| 数据 | 默认位置或载体 | 删除方式 |
| --- | --- | --- |
| 桌面设备清单 | `io.github.yourchaingod.pihub.desktop` 的系统应用配置目录中的 `devices.json` | 在 PiHub 中「移除设备」，或卸载后人工清理应用配置目录 |
| 桌面设备密钥 | macOS Keychain、Windows Credential Manager、Linux Secret Service 中独立的 `io.github.yourchaingod.pihub.desktop.auth.v1` 服务 | 「解除本机配对」或「移除设备」 |
| Pi 会话、设置、模型与 Provider 凭据 | 目标节点的 Pi Agent 数据目录，通常为 `~/.pi/agent` | 在目标节点按需备份后删除；桌面端移除设备不会删除它们 |
| Server 设备鉴权状态 | 目标节点的 `~/.pihub/auth.json` | 使用受信任设备或 `pihub-auth-admin revoke` 吊销；不要直接编辑状态文件 |
| Server 更新版本与事务状态 | macOS `~/Library/Application Support/PiHub/Server`；Linux `$XDG_DATA_HOME/pihub/server` 或 `~/.local/share/pihub/server`；Windows `%LOCALAPPDATA%\PiHub\Server` | 停止并卸载服务后人工检查、备份和删除 |
| Server 日志 | Unix `~/.local/state/pihub`；Windows `%LOCALAPPDATA%\PiHub\logs` | 从当前版本目录运行服务脚本的 `logs` 命令查看准确路径，停止服务后按需删除 |

「解除本机配对」只删除当前桌面机中的密钥，不会自动吊销远端设备身份；需要彻底撤销时还应在目标节点吊销对应 device id。服务脚本的 `uninstall` 只移除后台服务定义，刻意保留 Pi 数据、鉴权状态、更新状态和日志。

官方安装不会执行 `npm install`，也不会把 `pihub-server-service` 写入 PATH。当前版本号记录在 Server 数据根的 `state/current.json`，对应版本目录是 `versions/<version>`；人工维护时以当前 Node.js 运行其中的 `bin/pihub-server-install.js`：

```bash
node "<当前 Server 版本目录>/bin/pihub-server-install.js" status
node "<当前 Server 版本目录>/bin/pihub-server-install.js" repair
node "<当前 Server 版本目录>/bin/pihub-server-install.js" logs
node "<当前 Server 版本目录>/bin/pihub-server-install.js" uninstall
```

优先使用桌面端的设备维护入口。手工命令必须以安装该服务的普通用户运行；macOS/Linux 不要使用 `sudo`，Windows 不要使用管理员终端。

目标节点上的 `dev.pihub.server`、systemd 用户服务和 Windows 当前用户计划任务始终代表同一个 30141 端口的 PiHub Server，刻意不创建第二套并行服务。更新或卸载 Server 前应先确认运行中的会话和保留数据。

完整卸载建议按此顺序处理：

1. 在仍受信任的设备上吊销不再使用的设备身份。
2. 从当前 Server 版本目录运行 `node bin/pihub-server-install.js uninstall`。
3. 检查 Server 数据根、`~/.pihub/auth.json`、Pi Agent 数据与日志，分别备份后再由数据所有者决定是否删除；删除这些目录可能永久丢失设备身份、Provider 凭据和会话。
4. 检查并按需移除 Tailscale Serve 映射。
5. 在桌面端移除设备并使用操作系统的标准方式卸载 PiHub。

## GitHub 更新

桌面端只从固定仓库最新稳定 Release 的 `pihub-desktop-v1.json` 与 `pihub-desktop-v1.json.sig` 获取更新，签名清单还必须声明独立通道 `desktop-v1-stable`；不回退读取旧 `latest.json`。下载与安装完成后由用户重启应用。Server 只读取同一固定 GitHub 仓库最新 Release 的 `release-manifest.json`，并要求清单通道为 `stable`、资产 URL 指向不可变的 `v<version>` Release，再验证 Ed25519 清单签名、资产签名、大小和 SHA-256。更新由稳定 supervisor 执行：候选版本先在独立回环端口健康检查，切换后再次检查，失败则恢复 known-good 版本。

客户端不会内嵌 GitHub Token。因此，可供自动更新读取的 Release 资产必须匿名可访问；如果源码仓库保持私有，应使用独立的公开、只读 Release 源，并在新桌面版本和 Server 信任根中固定该来源。

## 本地开发

要求：

- Node.js `22.19.0` 或更高版本；
- Rust stable 和当前系统所需的 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)；
- npm；
- 需要测试真实设备流程时安装 Tailscale 和系统 OpenSSH 客户端。

```bash
npm ci
npm ci --prefix server
npm run tauri dev
```

`npm run dev` 只启动前端预览。浏览器预览无法使用 Tauri 凭据库、设备发现、SSH 引导或跨源设备请求，不能替代桌面集成测试。

### 常用验证

```bash
# 桌面前端
npm run build
npm run test:e2e

# Server
npm test --prefix server
npm exec --prefix server -- tsc --noEmit
npm run lint --prefix server
npm run build --prefix server

# 发布与脚本门禁
node scripts/check-release-config.mjs
node --test scripts/*.test.mjs

# Tauri
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## 排错

- 找不到设备：先运行 `tailscale status`，确认两端同属一个 Tailnet；再检查目标节点的 `tailscale serve status`。
- Server 状态异常：从当前版本目录运行 `node bin/pihub-server-install.js status`；定义漂移或进程异常时运行同一脚本的 `repair`。
- 需要日志路径：从当前版本目录运行服务脚本的 `logs` 命令。命令返回 JSON 路径，日志单文件上限 5 MiB 并保留一个轮转备份。
- 配对失败：重新生成配对码，确认未过期、未使用且系统时间正确；重复失败会触发限流。
- 更新失败：不要反复提交更新。等待状态进入 `failed` 或回滚完成，再检查私有本机日志和 GitHub Release 是否完整。

## 上游与许可证

PiHub 是独立的下游项目，不代表下列上游项目。Server 基于 [agegr/pi-web](https://github.com/agegr/pi-web) 的 MIT 代码改造（服务端入口与变量已全部更名为 `pihub-server`，与上游 pi-web 不冲突），并使用 [Pi Coding Agent](https://github.com/earendil-works/pi) 的 Agent 与会话运行时；内置 NewAPI Provider 源自 `ttimasdf/pi-provider-newapi`。

项目本身使用 [MIT License](LICENSE)。上游版权、修改来源和第三方许可说明见 [`NOTICE.md`](NOTICE.md) 与 [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md)。
