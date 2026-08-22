# PiHub Server

PiHub Server 是 PiHub 桌面客户端的 headless 设备服务。它复用 Pi Coding Agent 的会话与模型运行时，向已配对设备提供 Agent、文件、Git、终端、模型、插件、技能和更新 API。

Server 没有可操作的浏览器工作台：`/` 只显示运行状态，完整 UI 由 PiHub 桌面端本地渲染。普通安装应由桌面端的设备配置流程完成；本目录主要面向开发、审计和故障恢复。

## 运行边界

- Node.js `22.19.0` 或更高版本。
- 支持 macOS、Windows 和 Linux；发布包分别按 `darwin|linux|win32` 与 `arm64|x64` 构建。
- HTTP 服务默认监听 `127.0.0.1:30141`；hostname 强制为回环地址，不允许绑定 `0.0.0.0`。前台开发可选择其他有效端口，后台服务固定使用 `30141`。
- Tailnet 入口使用 `tailscale serve --https=30141 http://127.0.0.1:30141`。
- 不支持 Tailscale Funnel、普通 LAN 或公网直连。
- 除健康检查和一次性配对 claim 外，API 必须通过设备签名与 capability 检查。

直接前台运行已构建的 Server：

```bash
npm ci
npm run build
npm run start:headless
```

开发模式：

```bash
npm run dev:headless
```

开发服务仍只监听回环地址。不要把开发模式暴露给其他主机，也不要把 `.next` 开发产物打进发布包。

## 后台服务

正式安装由 PiHub Desktop 通过 SSH 发送短期 bootstrap 完成。bootstrap 不携带 Server 包，也不执行 `npm install`；它从固定 GitHub Release 下载当前平台的签名独立归档，通过完整验签、候选健康检查和事务切换后，再调用该版本内的服务脚本。官方安装不会把管理命令写入 PATH。

当前版本号记录在平台数据根的 `state/current.json`，版本目录为 `versions/<version>`：

- macOS：`~/Library/Application Support/PiHub/Server`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/pihub/server`
- Windows：`%LOCALAPPDATA%\PiHub\Server`

人工恢复时，以当前安装使用的 Node.js 直接运行版本目录内的脚本。命令必须以当前登录用户运行：macOS/Linux 不要使用 `sudo`，Windows 不要使用管理员终端。

```bash
node "<当前 Server 版本目录>/bin/pihub-server-install.js" install
node "<当前 Server 版本目录>/bin/pihub-server-install.js" status
node "<当前 Server 版本目录>/bin/pihub-server-install.js" repair
node "<当前 Server 版本目录>/bin/pihub-server-install.js" logs
node "<当前 Server 版本目录>/bin/pihub-server-install.js" uninstall
```

源码包的 `bin` 字段仍声明 `pihub-server-service` 与 `pihub-server-install` 兼容别名，供开发和诊断使用；正式发布链不依赖全局 npm 链接。

- 无参数调用等同于 `install`，仅用于引导兼容。
- `install` 已就绪时是幂等操作；安装或修复后会验证 `/api/health` 的精确版本。
- `status` 输出 JSON；未就绪时退出码为 `3`。
- `repair` 重建当前用户的服务定义，并在失败时恢复旧定义。
- `logs` 输出 JSON 格式的日志路径、大小上限和轮转数量。
- `uninstall` 只移除 LaunchAgent、systemd user unit 或 Windows 当前用户计划任务，保留数据、凭据和日志。

服务实现：

| 平台 | 服务管理器 | 定义 |
| --- | --- | --- |
| macOS | LaunchAgent | `~/Library/LaunchAgents/dev.pihub.server.plist` |
| Linux | systemd user service | `~/.config/systemd/user/pihub-server.service` |
| Windows | Task Scheduler | 当前用户的 `PiHub Server` 计划任务 |

Unix 日志位于 `~/.local/state/pihub`；Windows 日志位于 `%LOCALAPPDATA%\PiHub\logs`。每个日志文件上限为 5 MiB，并保留一个轮转备份；应优先运行当前版本服务脚本的 `logs` 命令获取准确路径。

## 设备配对与鉴权

### 首次配对

`POST /api/pairing/claim` 是一次性配对入口，但配对码必须先在目标节点本地签发。输入 JSON 不是秘密；输出 JSON 包含配对码，必须作为敏感文件处理。

创建 `pairing-request.json`：

```json
{
  "label": "My PiHub Desktop",
  "ttlSeconds": 300,
  "capabilities": [
    "agents:use",
    "sessions:read",
    "sessions:write",
    "files:read",
    "files:write",
    "workspaces:read",
    "workspaces:manage",
    "models:read",
    "models:manage",
    "providers:manage",
    "packages:read",
    "packages:manage",
    "terminal:use",
    "system:manage",
    "system:update",
    "devices:manage"
  ]
}
```

签发到一个尚不存在的私有输出文件：

```bash
umask 077
node "<当前 Server 版本目录>/bin/pihub-auth-admin.js" issue \
  --input pairing-request.json \
  --output pairing-grant.json
```

读取 `pairing-grant.json` 中的 `code`，在桌面端输入后立即删除该输出文件。配对码默认 5 分钟过期且只能成功使用一次。不要把配对码或设备 secret 放入 argv、环境变量、Shell 历史、日志或版本库。

如果明确需要在交互终端直接显示配对码，可以使用 stdin/stdout，并且必须显式加入 `--show-secret`：

```bash
node "<当前 Server 版本目录>/bin/pihub-auth-admin.js" issue \
  --input - --output - --show-secret < pairing-request.json
```

### 管理设备

```bash
node "<当前 Server 版本目录>/bin/pihub-auth-admin.js" list --output auth-state-summary.json
node "<当前 Server 版本目录>/bin/pihub-auth-admin.js" rotate --input rotate-request.json --output rotated-device.json
node "<当前 Server 版本目录>/bin/pihub-auth-admin.js" revoke --input revoke-request.json --output revoked-device.json
node "<当前 Server 版本目录>/bin/pihub-auth-admin.js" claim-sessions --input claim-request.json --output claim-result.json
```

管理命令只接受有界 JSON 输入；secret 不从 argv 或环境变量读取。`list` 不返回活动设备 secret。`rotate` 和 `issue` 的输出含新秘密，stdout 输出同样要求 `--show-secret`。

首次升级到设备隔离版本时，旧会话没有 owner。可以使用 `claim-sessions` 将指定会话或所有未归属会话分配给一个活动 device id；已归属其他设备的会话不会被夺取。

### 请求认证

受保护请求采用 `PiHub-HMAC-SHA256` 和 `pihub-request-v3` 签名上下文，覆盖：

- HTTP 方法与规范化请求目标；
- Unix 时间戳、随机 nonce 和鉴权 epoch；
- 请求体的 raw-wire SHA-256，包括 multipart 边界与字节；
- 设备 id 和设备 secret。

服务端验证时间窗口、nonce 防重放、body digest 和路由 capability。代理层会删除客户端伪造的内部身份 header，只把验证后的身份传给 route。公共方法仅为 `GET /api/health` 和 `POST /api/pairing/claim`；未知或未登记的 API 默认拒绝。

Capability 定义位于 `lib/pihub-auth-shared.ts`。签发设备时应只授予实际需要的集合；完全使用桌面工作台需要上例中的完整集合。

## 数据与隐私

| 数据 | 默认位置 |
| --- | --- |
| Pi 会话、设置、模型、Provider 凭据、插件和技能 | Pi Agent 数据目录，通常为 `~/.pi/agent` |
| 设备 secret 与一次性配对摘要 | `~/.pihub/auth.json` |
| 会话 owner 映射 | Pi Agent 数据目录中的 `session-ownership.json` |
| 更新版本、事务 journal 和 current 指针 | 见 [`docs/release.md`](docs/release.md) 的平台目录 |
| 运行日志 | 当前版本服务脚本的 `logs` 命令返回的路径 |

鉴权与 owner 状态使用私有目录和原子写入；Unix 文件权限收紧为 `0600`。Provider 凭据沿用 Pi Agent 的 `auth.json`，不会返回给桌面端。Server 不提供遥测上传；正常外联来自用户选择的模型 Provider、插件/技能操作、Tailscale 和固定 GitHub 更新源。

删除桌面端设备或解除本机配对不会删除这些远端数据，也不会自动吊销远端设备记录。彻底撤销访问应使用 `pihub-auth-admin revoke` 或带 `devices:manage` capability 的受信任设备。

## 文件、Git 与终端

- 文件访问先解析到已授权工作区根，再进行规范路径、符号链接、TOCTOU 和文件类型检查。
- 上传使用流式 multipart 解析、raw-wire digest 和硬大小限制；临时文件通过原子发布，失败时清理。
- Git 命令不经过 shell；worktree 操作要求可信项目，并在强制删除前由客户端再次确认。
- 终端使用 `node-pty`；会话按设备 owner 隔离并设有全局、每设备和订阅者数量上限。
- 项目级扩展可执行本地代码，必须先通过项目信任流程。

Git worktree 的用户行为见 [`docs/worktrees.zh-CN.md`](docs/worktrees.zh-CN.md)。

### 发布安全门禁

文件 API 已使用 descriptor 身份复验、`O_NOFOLLOW`（平台支持时）、目录 guard 与原子发布缩小路径竞争窗口；worktree 授权也会复验 `realpath`、设备/节点身份和 Git 注册关系。但纯 Node.js 无法在三平台提供完整的 handle-relative `openat`/`renameat2` 或 Windows 等价语义，因此不能宣称已经消除同一 OS 用户恶意进程在最终 pathname syscall 前替换祖先目录的 TOCTOU 风险。

授权根撤销和重绑同样会拒绝 symlink/junction、owner 撤销和可检测的对象身份变化；mount/FUSE 在相同 `realpath` 上重绑定，以及跨 Server 重启的 durable file-id 验证，仍属于残余风险。发布前必须在 Windows、macOS 和 Linux 真实 runner 上验证 junction、ADS/保留名、大小写与 Unicode 别名、rename replacement、Git executable 隔离和服务安装/升级/卸载生命周期。任何平台未验证、验证失败，或把上述残余风险误报为已关闭，均应阻止发布。

## 更新

Server 更新只读取代码中固定的 GitHub owner、repo、channel 和 Ed25519 公钥，不读取客户端提供的 URL、公钥或 GitHub Token。稳定 supervisor 负责下载、验签、解包、候选健康检查、原子切换、崩溃恢复和失败回滚。

完整清单格式、资产约束、API 状态机和发布门禁见 [`docs/release.md`](docs/release.md)。发布源必须匿名可读；私有源码仓库不能直接作为无 Token 客户端的更新源。

## 开发与验证

```bash
npm ci
npm test
npm exec -- tsc --noEmit
npm run lint
npm run build
```

`npm test` 覆盖 `app/**/*.test.mjs`、`bin/**/*.test.mjs` 和 `lib/**/*.test.mjs`。发布包由仓库根目录的 `scripts/build-server-release.mjs` 在目标平台原生构建；`node-pty` 等原生依赖不能跨平台复用。

常用目录：

```text
app/api/             headless HTTP API routes and route tests
app/page.tsx         minimal server status page
bin/pihub-server.js  stable supervisor entry point
bin/server-supervisor.js
                     child lifecycle and update IPC owner
bin/pihub-server-install.js
                     cross-platform service CLI
bin/pihub-auth-admin.js
                     local authentication administration
lib/pihub-auth*.ts   signing, policy, device store and HTTP helpers
lib/session-*.ts     session reading, ownership and access control
lib/file-*.ts        authorized file operations and upload security
lib/worktree.ts      Git worktree operations
lib/pihub-terminal.ts
                     PTY/ConPTY sessions
lib/server-*.ts      signed release trust and update runtime
docs/                current protocol and focused operator guides
```

维护者约束见 [`AGENTS.md`](AGENTS.md)。

## 上游与许可证

PiHub Server 基于 [agegr/pi-web](https://github.com/agegr/pi-web) 的 MIT 代码持续改造，并依赖 [Pi Coding Agent](https://github.com/earendil-works/pi) 的运行时。它不再发布 Pi Web 的浏览器/PWA 界面；入口为 `bin/pihub-server.js`，公开命令均使用 `pihub-*`。

许可文本见 [`LICENSE`](LICENSE)；项目级第三方声明见 [`../NOTICE.md`](../NOTICE.md) 与 [`../THIRD_PARTY_LICENSES.md`](../THIRD_PARTY_LICENSES.md)。
