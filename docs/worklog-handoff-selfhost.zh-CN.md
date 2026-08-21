# PiHub 自用化改造交接说明（第二轮）

> 文档版本：`0.0.1-selfhost`
>
> 记录日期：2026-08-20
>
> 适用范围：本轮的方向调整（自用、本地预编译）、功能修复、工程优化、安全边界放宽、直传安装与自动配对

这份文档是 `docs/worklog-handoff.zh-CN.md`（第一轮审计基线）之后的第二轮工作记录。它只描述已经落到源码并经过验证的内容、方向性决策的变化，以及后续维护的建议顺序。文档不包含设备地址、凭据、配对码、私钥或本机绝对路径；提到的远程机器一律用角色代称。

## 1. 方向性变化（必读）

第一轮的所有发布设计都围绕 GitHub 签名 Release。本轮所有者明确：**软件纯自用、不分发，连接只在 Tailscale 内网，服务器安全适度放宽**。由此产生的顶层决策：

| 决策 | 影响 |
| --- | --- |
| 不走 GitHub 分发，本地预编译 + SSH 直传安装 | 新增与签名链并行的本地归档安装路径；GitHub 链路代码保留但不再是主路径。 |
| 部署后自动配对 | bootstrap 成功即完成设备配对，不再手工生成/粘贴配对码。 |
| 允许任意目录作为工作区 | `/root`、`/home` 等原先受保护目录现在可授权，仅保留文件系统根 `/` 的拦截。 |
| 放宽大小配额 | 上传、预览、终端数量上限全面提高（见 §4.4）。 |
| 允许以 root 安装 | 桌面端二次确认 + `PIHUB_ALLOW_ROOT=1` 显式放行；脚本单独运行仍默认拒绝。 |

第一轮的四个交接边界中，"远端访问只走受信任 Tailnet"与"失败操作可回滚"保持不变；"插件来源可验证"改为本地 sha256 校验（自用场景不再要求签名）；"用户配置不可被静默覆盖"不变。

## 2. 用户反馈的三个问题（已修复）

1. **远端 TodoList 不显示**：`pi-todo-rail` 通过 `extension_ui_request`/`setWidget` 事件推送待办栏，Server 协议与 `get_state` 快照（`extensionWidgets`）早已就绪，前端把事件静默丢弃。已在 `src/Workspace.tsx` 消费 `setWidget`（含清除语义）与 `set_editor_text`（写入草稿），按 `aboveEditor/belowEditor` 渲染在输入区上/下方，ANSI 转义剥离。快照字段缺失（旧 Server）时保留事件状态，空数组为权威清空。
2. **文件无法 @ 引入**：输入框 `@` 触发文件补全（小索引本地过滤，≥5000 条走服务端 `?q=` 模糊搜索，150ms 防抖），Tab/Enter 插入、Esc 关闭；文件面板右键菜单新增"在消息中引用"。`@path` 以纯文本随消息发出（含空格自动加引号），agent 按会话 cwd 自行读取。Server 零改动。
3. **消息区难复制、框选易掉**：助手消息加复制按钮（原先只有用户消息有）；`MessageView`/`Markdown` memo 化（流式期间未变消息不重渲染，浏览器原生选区不再坍塌）；流式 delta 改 rAF 合批；代码块加悬浮复制按钮。

另加：**连续纯工具调用消息合并**为一张可折叠分组卡片（"N 个工具调用"，失败计数标注），`toolResult` 条目对分组透明。

## 3. 工程优化（已落地）

- `src-tauri/src/lib.rs`（4517 行）拆分为 `transport.rs` / `devices.rs` / `setup.rs` / `streaming.rs` / `files.rs` / `discovery.rs` / `credentials.rs` / `util.rs` 等域模块，`lib.rs` 仅剩胶水层。`check-release-config.mjs`、`product-identity.test.mjs`、`check-extension-manifest.mjs`（新增，5 处扩展清单交叉校验，`npm run check:extensions`）已适配拆分后的结构。
- 终端 250ms 轮询改为 SSE 推送：复用 Server 已有的 `/api/pihub/terminal/[id]/events` 路由（补 30ms 输出合批，保留背压关停），Rust 新增 `start/stop_terminal_stream`（key 加 `term:` 前缀防互踢），前端断流自动回退轮询（浏览器/旧 Server 兜底）。
- 上传分块：8MB 切片逐块过 IPC（峰值从 ~340MB 降到 ~11MB），Rust 侧临时文件重组、失败必清理，Server 协议不变。
- 默认服务端口设置持久化（原先重启即丢，与设置弹窗文案矛盾）。

## 4. 安全边界调整（所有者明确决策）

### 4.1 工作区目录

`server/lib/allowed-roots.ts` 的 `isUnsafeCanonicalRoot` 现在只拦截文件系统根。原先的 home 目录、敏感目录（`.ssh`、`.pi`、系统目录等）拦截全部移除。历史会话的 cwd（如 `/root` 下）因此可直接授权使用。

### 4.2 root 安装

三道原本拒绝 root 的门禁全部改为 `PIHUB_ALLOW_ROOT=1` 显式放行：

- `src-tauri/src/setup.rs` 的 `unix_bootstrap_ssh_user`（root 时脚本注入 `PIHUB_ALLOW_ROOT=1`）；
- `src-tauri/src/standalone_bootstrap.mjs` 的 `installStandaloneRelease`；
- `server/bin/pihub-server-install.js` 的 `assertUnprivilegedUser`。

桌面端流程：SSH 用户名填 `root` → 弹危险确认框（明示权限隔离失效）→ 确认后才继续。脚本被单独拷出运行时仍默认拒绝 root。

### 4.3 配额

- 上传：单文件 25MB→256MB、总量 100MB→1GB（前端、`streaming-multipart-upload.ts`、Rust 分块上限同步）。
- 预览：文本 256KB→2MB；图片/DOCX 10MB→25MB；附件图片 10MB→25MB。
- 终端：每设备 4→8（仍可用 `PIHUB_TERMINALS_*` 环境变量覆盖）。

请求签名、重放防护、capability 最小授权、回环监听 + Tailscale-only、PTY/上传的临时文件私有权限与原子发布，全部保留。

## 5. 本地预编译与直传安装（新主路径）

### 5.1 出包

在**与目标同平台/架构的构建机**上（发布包含平台原生依赖，不能跨平台复制）：

```bash
node scripts/build-server-release.mjs --platform linux --arch x64
# 产物：<output>/pihub-server-<version>-<platform>-<arch>.tar.gz + .sha256 + .asset.json
```

- 该脚本本来就不依赖 GitHub；新增 `PIHUB_LOCAL_BUILD=1` 跳过 SBOM（magic-context 的 peer 例外 `AUDITED_PEER_COMPATIBILITY_OVERRIDES` 与 `npm sbom` 冲突，本地安装不消费 SBOM）。
- staging 扫描与归档校验的体积上限已随 onnxruntime/sharp 原生依赖（约 500MB）上调。
- `scripts/default-extension-bundle.mjs` 的 `AUDITED_PRIVACY_FINDINGS` 新增 9 条上游构建路径登记（magic-context 脱敏正则、quickjs/onnxruntime sourcemap 与 dylib），均按 sha256 钉住。
- 小内存构建机注意：`/tmp` 若是 tmpfs，需把 `PIHUB_PORTABLE_BUILD_ROOT`、`TMPDIR` 指向磁盘；`npm ci` 可能需要 swap。
- `server/lib/default-extensions.ts` 修了一个真实 bug：校验遍历顺序（DFS 逐层排序）与 bundle 工具的全路径排序不一致，遇到 `src/path/` 与 `src/path-normalizer.ts` 这类同名前缀即失败，已统一为全路径排序。

### 5.2 直传安装

桌面端"连接设置"新增**本地发布包目录**（`pihub-local-release-dir`）。SSH 一键安装时：

1. 先 `tailscale ssh <target> uname -sm` 探测平台/架构；
2. 在目录中匹配 `pihub-server-*-<platform>-<arch>.tar.gz`（多版本取最新），校验 `.sha256` 并复核归档摘要；
3. 归档经 SSH stdin 直传目标机，`bootstrap_unix.sh` 落盘后以 `PIHUB_LOCAL_ARCHIVE`/`PIHUB_LOCAL_ARCHIVE_SHA256` 调用 `standalone_bootstrap.mjs` 本地模式——跳过 manifest/签名，其余（结构校验、事务 journal、健康检查、服务安装、失败回滚）与签名链完全复用。

Windows 目标的直传本轮未做，命令层明确报错拒绝。

### 5.3 自动配对

`PIHUB_AUTO_PAIR=1` 时，安装成功且服务健康后在目标机签发一次性配对码（全 16 项 capability、ttlSeconds=600），经 stdout 单行 `PIHUB_PAIRING_CODE=` 回传；桌面端解析后自动 `pair_device` 完成 claim 并写 keychain。配对码在日志订阅、消息展示、错误尾行三处过滤，不进 UI 与持久化日志。已配对目标不重复签发。

### 5.4 桌面端崩溃修复

`tauri.conf.json` 原先没有 `plugins.updater`（官方构建靠 `--config` 注入），但 Rust 无条件注册 updater 插件，本地 `tauri build`/`tauri dev` 启动即 panic。已把 pinned endpoint + 公钥写入基础配置，本地构建与官方 `--config` 覆盖兼容。

## 6. Tailscale 运维事实（本轮踩过的坑）

- 桌面机 **Tailscale DNS 被关闭**会导致系统层无法解析 MagicDNS 域名，扫描全灭（Rust 客户端自身经 `tailscale status` 钉 IP，但诊断时应先确认 `tailscale dns status`）。
- **显示名**现在取 DNSName 首段（Tailscale 后台改名即生效），不再用机器自报的 HostName；`Device` 新增稳定 `ip` 字段（CGNAT），扫描时按 IP 重锚定名称与 URL，改名不再"丢设备"。注意：凭据按 URL 存于 keychain，改名后需重新配对一次。
- Tailscale Serve 的 HTTPS 证书只签给域名（SNI），**不能直连 CGNAT IPv4**；Serve 配置跟随机器名，改名后需在目标机 `tailscale serve reset` 后重新挂 30141。
- Debian 10（systemd 241）不认带引号的 `WorkingDirectory=`，安装器已改为仅在必要时加引号（`systemdPathDirective`）。
- tailnet ACL 的 `tailscale.ssh.users` 决定可登录用户；PiHub 侧已允许 root（见 §4.2），但 ACL 侧仍需自行放行。
- 旧版本服务（0.9.10 系统级 `pihub-server.service`、0.2.1）与新安装同抢 30141；装新版前需停旧服务（本轮已在两台目标机上处理，旧单元文件保留可回滚）。
- root 经 tailscale ssh 无 session bus 时，需 `loginctl enable-linger root` + `systemctl start user@0.service` 并导出 `XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS`。

## 7. 两台目标机的当前状态（角色代称）

- **构建机（linux x64）**：`/root/pihub-build` 保留完整构建环境（源码、依赖、portable 构建产物），可重复出包；`/root/tmp` 为构建暂存盘。
- **目标机 A（linux x64，手动安装）**：0.0.1 由源码树（`/root/pihub-src`）安装运行；历史会话 6 个已 `claim-sessions` 认领；7/7 插件已 provisioning（含 Magic Context 强制配置）；NewAPI 网关模型已刷新（11 个）；历史会话主目录（`/home/<user>`）已授权为工作区；曾临时加 2GB swap（`/swapfile-pihub`）。
- **目标机 B（linux x64，直传验证机）**：用 §5 的 tarball 全新安装，服务健康、Serve 就绪；验证了"本地归档 → 解包 → 服务 → 健康"全链路。`state/current.json` 的规范格式为 `{"schemaVersion":1,"version":"0.0.1"}`（紧凑规范 JSON，手写过容易踩）。
- 两台机器上都签发过一次性配对码（短时效，过期需在目标机 `pihub-auth-admin issue` 重签，或走自动配对）。
- 桌面机上有一个**误装的本机 Server 服务**（`dev.pihub.server` LaunchAgent，0.0.1）——排查时意外注册，是否卸载留待所有者决定。

## 8. 验证记录

| 范围 | 结果 |
| --- | --- |
| 根 lint / tsc / 单测 / build | 通过 |
| Playwright Chromium 全量 | 57 passed（其余浏览器本轮未重跑，第一轮为 165） |
| Server 全量测试 | 801 passed |
| 发布脚本测试 | 93 passed |
| Rust 测试 | 64 passed / 1 ignored |
| cargo fmt / clippy | 通过，0 warning |
| 隐私扫描 | 495 tracked files，0 errors / 0 warnings |
| 扩展清单交叉校验（新） | 7 包 5 源一致 |
| 直传安装端到端 | linux x64 目标机完成（见 §7 目标机 B） |

## 9. 已知限制与未关闭事项

| 优先级 | 事项 | 说明 |
| --- | --- | --- |
| P1 | Windows 目标直传与自动配对未实现 | 命令层明确拒绝；需要时补 ps1 的 stdin 归档路径。 |
| P1 | 桌面机本机 Server 服务误装未处理 | `node bin/pihub-server-install.js uninstall` 可移除（保留数据）。 |
| P1 | 改名后需重新配对 | 凭据按 URL 存 keychain；根治需凭据改按稳定身份索引。 |
| P2 | NewAPI 模型缓存为空时不自动刷新 | 首次配对后需在"管理模型配置 → NewAPI → 刷新"手动拉一次；可在服务端加空缓存自动刷新。 |
| P2 | 扩展依赖体积大 | onnxruntime/sharp 原生依赖约 500MB，发布包 293MB；如在意可审计 magic-context 的 embeddings 依赖是否可选。 |
| P2 | 工作区残留物 | 目标机 A 的 `/root/pihub-src` 与 swapfile、构建机的 `/root/pihub-build` 均刻意保留。 |
| P2 | deepseek-harness (dsh) 兼容 | 仅调研过，未排期；其 Web UI（`npx @deepseek-ai/dsh web`）可作参考，项目尚在 developer preview。 |
| P3 | 发布契约历史文档滞后 | `README.md`、`docs/release.md` 仍描述 GitHub 分发为主路径，待按本轮方向统一改写。 |

## 10. 下一位维护者的执行顺序

1. 读本文件与第一轮 `docs/worklog-handoff.zh-CN.md`，注意 §1 的方向变化已取代其中"GitHub 分发为唯一主路径"的设定。
2. `git status --short`、`git diff --check`；工作区有大量未提交改动，先复核再决定提交策略。
3. 重跑门禁（§8 的命令集，含 `npm run check:extensions`）。
4. 出包前确认构建机与目标同平台/架构；`PIHUB_LOCAL_BUILD=1` 只在自用构建时设置。
5. 部署新机器：桌面端填好本地发布包目录 → SSH 一键安装 → 观察"接收本地预编译服务包 → 已自动配对"。
6. 若要给 Windows 目标直传，先补 `bootstrap_windows.ps1` 的 stdin 归档与 `setup.rs` 的 Windows 分支，再补对应 e2e。

## 11. 关键文件索引（本轮新增/重点）

- 本地归档安装：`src-tauri/src/standalone_bootstrap.mjs`（`PIHUB_LOCAL_ARCHIVE*`、`PIHUB_AUTO_PAIR`）、`src-tauri/src/bootstrap_unix.sh`、`src-tauri/src/setup.rs`（`probe_remote_platform`、`find_local_archive`、`load_local_archive`）
- 自动配对前端：`src/App.tsx`（本地发布包目录设置、配对码过滤）、`src/lib.ts`（`bootstrapPairingCode`、`scrubBootstrapSecrets`）
- 出包：`scripts/build-server-release.mjs`、`scripts/verify-server-release.mjs`、`scripts/default-extension-bundle.mjs`
- 安全放宽：`server/lib/allowed-roots.ts`、`server/lib/streaming-multipart-upload.ts`、`server/lib/file-types.ts`、`server/lib/image-attachments.ts`、`server/lib/pihub-terminal.ts`
- root 放行：`src-tauri/src/setup.rs`、`src-tauri/src/standalone_bootstrap.mjs`、`server/bin/pihub-server-install.js`
- 三问题修复：`src/MessageView.tsx`、`src/Workspace.tsx`、`src/types.ts`、`src/styles.css`
- 改名鲁棒性：`src-tauri/src/discovery.rs`、`src-tauri/src/devices.rs`（`Device.ip`）、`src/App.tsx`（`reconcileDeviceIdentities`）

## 12. 交接原则（更新版）

- 连接只在 Tailnet，不引入公网/局域网回退；Server 只听回环，外口只有 Tailscale Serve。
- 本地归档完整性靠 sha256 钉死；传输只走 SSH stdin，不落第三方。
- 任何放宽都必须有显式确认入口（root 二次确认、`PIHUB_ALLOW_ROOT=1`），脚本单独运行时保持默认拒绝。
- 失败操作必须可回滚（事务 journal、旧版本目录、旧服务单元文件均保留）。
- 配对码、设备 secret、Provider 凭据不进文档、日志、聊天记录与测试 fixture。

## 13. 第三轮追加（2026-08-20，同一天晚些时候）

按所有者反馈做的六项修复/重设计 + 两台目标机与桌面端的部署，均已落到源码并过门禁。机器仍用角色代称：**目标机 A** = 第二轮手动源码树安装的那台；**目标机 B** = 第二轮 tarball 直传验证机（standalone 布局 `~/.local/share/pihub/server`，user 级服务 + linger）；**构建机** = 保留 `/root/pihub-build` 的那台（注意：它同时跑着一个第二轮之前遗留的旧版系统服务，本轮已卸载，见 §13.6）。

### 13.1 magic-context 只对每个进程第一个会话生效（根因修复）

`@cortexkit/pi-magic-context` 的入口用进程级 latch（`Symbol.for("magic-context.pi.active")`）防重复注册——pi TUI 单会话进程没问题，但 PiHub Server 单进程托管多个 AgentSession，SDK 每个会话都会重调扩展工厂函数（`loader.js` 的 `await factory(api)`），于是只有进程内**第一个**会话完成注册，之后全部静默跳过（"in-process re-init detected"）。修复在 `server/lib/safe-model-runtime.ts`：`createSafeAgentSessionServices` 每次构建会话服务前清一次该 latch（`resetExtensionProcessLatches()`，有行为测试）。扩展的进程级资源（sqlite 句柄按路径单例、配置迁移去重）本身有保护，逐会话重复注册安全；其事件处理器本就注册在会话级 API 上。**所有跑 0.0.1 的机器都有此 bug**，与安装方式无关。两台目标机均已部署修复（见 §13.6）。

### 13.2 消息区分组与重设计（`src/MessageView.tsx`、`src/ChatMinimap.tsx`、`src/Workspace.tsx`、`src/styles.css`）

- 合并规则从「纯工具调用」扩到「工具调用和/或思考、无正文、无错误」的连续助手消息（`isActivityOnly`）；组内按原始顺序交错渲染思考行与工具行，头部汇总 `N 个工具调用 · M 段思考`（含失败计数、模型、时间），行改为紧凑样式（状态点 + 单行预览 + 展开详情）。
- ChatMinimap 的测量与 MessageView 分组规则对齐（原先合并组会让 `.original-message` 元素计数错位，导航定位漂移；注意 toolResult 条目不打断分组）；视觉重设计：圆点 + 主题色当前节点，悬浮预览改为圆角浮层卡片。
- 左侧栏会话菜单「复制会话」（实际是 fork 出一份会话）改为「复制会话 ID」（写剪贴板）。
- 切换会话滚动位置记忆：原有机制在切换那一帧用旧会话的 detail 提前消费了恢复标记，导致永远不恢复；加 `detailRef.current !== detail` 守卫修复。
- 新 e2e：`tests/e2e/workspace-polish.spec.ts`（分组合并 / 复制会话 ID / 滚动记忆 3 条）。

### 13.3 设备中心「版本更新」去 GitHub

- 新增 Tauri 命令 `check_local_server_update(directory, platform, current_version)`（`src-tauri/src/setup.rs`）：扫描本地发布包目录中 `pihub-server-<version>-<platform>-*.tar.gz`（arch 由直传链路探测），semver 取最高，无有效 .sha256 sidecar 的候选不纳入；win32 明确拒绝。
- 「版本更新」tab（`src/DeviceSetup.tsx`）重写：Server 行 = 本地包检测 + 「直传安装」（复用 `bootstrap_tailnet_peer` 链路：Linux 收集 SSH 用户名、root 二次确认、有会话运行时确认、日志流展示、配对码过滤）；Desktop 行只读展示当前版本（自用构建，不再调 tauri updater 的 GitHub endpoint）。桌面端不再调用 `/api/pihub/updates`（Server 路由与 GitHub 链路代码保留未动）。
- 设备中心弹窗由 Workspace 窗口渲染，拿不到 App 主窗口状态；本地发布包目录经 `src/lib.ts` 的 `localReleaseDirectory()` 直读同一 localStorage 键（`pihub-local-release-dir`）。
- `src/App.tsx` 两处 GitHub 文案改为本地直传语义；`tests/e2e/pihub.spec.ts` 的更新用例整组重写（9 条）。

### 13.4 直传安装器的两个真实 bug（部署 B 时发现并修复，`src-tauri/src/standalone_bootstrap.mjs`）

- **扩展清单节点上限**：严格 JSON 解析器（防重复键）固定 20,000 节点上限，但完整 bundle 的 `inventory.json` 有 5500+ 文件（每文件 4 节点），任何全量直传安装都会报 "Release manifest exceeds structural limits"。已把上限改为随 `MAX_EXTENSION_FILES` 缩放（`MAX_EXTENSION_FILES * 4 + 64`），签名清单调用点保持 20,000 不变。
- **`PIHUB_ALLOW_ROOT` 不传播**：`sanitizedChildEnvironment` 白名单没有它，root 安装永远在服务安装子进程处被拒。已加入白名单（它本来就是需要显式确认的安全开关）。
- `parseExtensionInventory`、`sanitizedChildEnvironment` 已导出并有针对测试（该文件现 21 条测试）。

### 13.5 出包/部署运维事实（本轮踩过的坑）

- `scripts/build-server-release.mjs` **只打包既有 `.next`，不触发构建**；改 server 源码后必须先 `cd server && npm run build` 再出包，否则产物是旧的。
- 远程构建时用管道 `... | tail` 会掩盖退出码（`cmd | tail` 的退出码是 tail 的）——关键构建要么 `set -o pipefail`，要么落日志后查 `exit=$?`。
- 构建机 `/tmp` 是 tmpfs（约 1GB），portable 构建必须设 `PIHUB_PORTABLE_BUILD_ROOT=/root/tmp/<不存在的子目录>`（脚本要求 root 不存在）+ `TMPDIR=/root/tmp`。
- 目标机 A 是 Debian 10（glibc 2.28）：Turbopack 拒绝 WASM 绑定，只能 `next build --webpack`。
- 机器间 `tailscale ssh` 会触发额外认证检查导致stdin 管道挂起；tailnet 内传大文件可用临时 `python3 -m http.server --bind <CGNAT IP>`（用完即杀）。
- 手动在目标机跑安装器时，`standalone_bootstrap.mjs` 是带占位符的模板，需按 `setup.rs` 的 `render_standalone_bootstrap_helper` 渲染；扩展清单的顺序以 `PIHUB_EXTENSION_PACKAGES` 为准（与 `extensions/package.json` 的字母序不同，渲染错顺序会报 "Bundled extension inventory package contract is invalid"）。

### 13.6 部署与清理记录（第三轮）

- **目标机 A**：同步 `safe-model-runtime.ts` → 本机 `next build --webpack` → 重启 user 级服务，健康检查通过，编译产物确认含修复。
- **目标机 B**：构建机重建 `.next` 并重新出包（打包前先 grep 确认修复进了产物），tailnet 内 HTTP 直传 tarball（sha256 复核），停服后就地替换 `versions/0.0.1`（旧目录备份 `versions/0.0.1.bak-20260820` 可回滚），重启健康检查通过。小内存机器上安装器的事后健康检查曾超时回滚，故走就地替换。
- **桌面端**：`npm run tauri build` 重新编译，`/Applications/PiHub Desktop.app` 已替换为含第三轮改动的新包（替换前的 0.0.1 备份为 `PiHub Desktop.app.backup-20260820-145955`），启动验证无崩溃。
- **老版本清理（所有者明确指示）**：`/Applications/PiHub.app`（0.2.1）已删除；桌面机误装的 `dev.pihub.server` LaunchAgent 已卸载（官方 uninstall 中途报 rollback 错，手动删残留 plist；数据目录未动）——§9 的对应 P1 项就此关闭；构建机上旧版 0.9.9 系统级 `pihub-server.service` 已 stop/disable/删除（unit 备份在该机 `/root/pihub-server.service.0.9.9.bak`），其 Tailscale Serve 配置已 reset，pi-node 下的旧 `@pihub/server` 全局包已删。
- 未动：`/Applications` 下 8 月 18–19 日的 17 个 `PiHub.app.backup-*`；其余两台 linux 机器上处于 inactive 的旧 `pihub-server.service` 单元；目标机 A 上 failed 状态的旧系统单元（第二轮刻意保留的回滚件）。

### 13.7 验证记录（第三轮）

| 范围 | 结果 |
| --- | --- |
| 根 lint / tsc / test:unit | 通过 |
| Playwright Chromium 全量 | 59 passed（含新增 workspace-polish 3 条、重写后的 9 条更新面板用例） |
| Server 全量测试 | 802 passed（+1 latch 行为测试） |
| Rust | 66 passed / 1 ignored；fmt / clippy 0 warning |
| 安装器测试（standalone_bootstrap） | 21 passed（+2：清单节点上限、env 白名单） |
| `npm run check:extensions` | 7 包 5 源一致 |
| 目标机 A / B 部署 | 健康检查通过，运行产物均确认含 latch 修复 |
| 桌面端 | tauri build 通过，替换 /Applications 后启动正常 |

### 13.8 未关闭事项（增量）

- 其余机器上的 inert 旧单元文件、`/Applications` 下的旧备份 app 是否清理，由所有者决定。
- 桌面端「连接设置 → 本地发布包目录」现在是更新检测的唯一版本源，不填则设备中心只显示当前版本。
- README/docs/release.md 的 GitHub 分发描述依旧滞后（沿袭第二轮 P3）。

## 14. 第四轮追加（2026-08-20）：界面美化、更新检测增强、资源面板修复、思考强度默认值

按所有者四点反馈落地，均已过门禁。

### 14.1 右侧栏「资源」面板报"API 路由或请求方法不在桌面端允许列表中"（根因修复）

`ResourceManager` 调用的 `/api/project-trust`、`/api/skills`、`/api/plugins`（GET/POST/PATCH）不在 Rust 传输层允许列表 `validate_generic_api_route`（`src-tauri/src/transport.rs`），Tauri 环境下请求被本地拦截。已按既有"方法 + 结构化路径 + query 形状"模式补齐这 6 条路由；同一缺陷波及的 `/api/git/diff` 与 `/api/worktrees`（右侧栏 Git 面板在用）一并补齐。`generic_api_uses_structured_route_allowlist` 测试已扩充正反向用例。

### 14.2 思考强度默认最大

新会话未显式指定思考级别时，原先由 pi SDK 自行决定（非最大）。现在 `server/lib/model-scope.ts` 新增 `maxThinkingLevel`（按 `off < minimal < low < medium < high < xhigh < max` 规范序取模型支持的最高级，数据源复用 pi-ai 的 `getSupportedThinkingLevels`）与 `withMaxThinkingDefault`；`rpc-manager.ts` 只在**新会话**（无历史消息）且未显式指定、无 scope pin 时兜底填入。该默认值不写入 `settings.json` 的 `defaultThinkingLevel`（explicit 参数不变），不影响 pi CLI；存量会话保持原级别。测试：`model-scope.test.mjs` +2、`rpc-manager.test.mjs` +1（含"不持久化"源码断言）。

### 14.3 更新检测覆盖 pi 与全部插件，busy 支持强制更新

- **服务端暴露真实版本**：`/api/pihub/setup` 的 `pi` 字段新增 `version`（读 `@earendil-works/pi-coding-agent` 包 package.json）；`defaultExtensions.packages[]` 新增 `installedVersion`（facade package.json 的实际版本，未安装为 `null`），原 `version` 仍是 bundle 期望版本。
- **发布包携带组件版本**：`build-server-release.mjs` 的 `.asset.json` 新增 `pi` 与 `extensions` 字段（分别取自 server 钉版依赖与 `DEFAULT_EXTENSION_PACKAGES`）；`check_local_server_update`（`src-tauri/src/setup.rs`）优先解析候选归档的同名 `.asset.json`（校验 `filename` 匹配、名称/版本字符白名单、64KB 上限），缺失或不一致时回退到编译期常量。
- **版本更新 tab**（`src/DeviceSetup.tsx`）：Server 行下方新增「组件版本」清单（Pi Agent 运行时 + 7 个插件，`当前 → 包内` 对比）；Server 新版**或任一组件不一致**都会出现直传入口（组件不一致时按钮为「直传同步组件」）。老 Server 不报新字段时对应行跳过比对（显示"包内 vX"）。
- **busy 强制更新**：运行中会话的确认弹窗改题为「有会话正在运行 — 强制更新」，确认钮「强制更新」（安装器本身无 busy 门禁，确认即强制；语义明示化，无协议变化）。
- e2e：mock（`tests/e2e/desktopMock.ts`）补齐 `pi`/`extensions`/`installedVersion` 与 `staleComponent` 场景；`pihub.spec.ts` 更新组新增"组件不一致 → 直传同步组件"用例，busy 用例改用新按钮名。

### 14.4 参考 deepseek-harness Web UI 的界面美化（纯 CSS，`src/styles.css`）

参考 dsh 设计体系（`packages/client/ui-theme`）做的 token 级改造，未动 DOM、未加依赖：

- 暗色板收敛到蓝灰中性系（基底 `#151517`、面板 `#1B1B1C`、抬升面 `#232324/#2C2C2E`），边框由灰色 hex 改为 alpha 白分级（亮色主题为 alpha 黑）；文本四级层次；accent 微调 `#679efe`。
- 用户消息气泡圆角 21px、`max-width: min(525px, 82%)`；元信息 `tabular-nums`。
- 输入区改为悬浮胶囊卡片（19px 圆角、分层阴影），上方 36px 渐变淡出遮罩；发送/停止按钮圆形。
- 代码块 12px 圆角、13px/1.7 代码字号；「运行中」状态改品牌蓝微光扫动文本（`prefers-reduced-motion` 与 `forced-colors` 均有回退）。
- 全局 8px 细滚动条、侧栏指针移出隐藏 thumb；过渡统一 `cubic-bezier(0.4,0,0.2,1)`；菜单/模态改分层柔和阴影。
- 偏差记录：dsh caption 色 `#81858C` 对比度不达标（axe 拦截），`--text-dim` 用 `#8A9097`；dsh 的代码块吸顶语言条需要改 DOM，本轮未做。

### 14.5 验证记录（第四轮）

| 范围 | 结果 |
| --- | --- |
| 根 lint / tsc / test:unit | 通过 |
| Rust | 68 passed / 1 ignored（+2：asset.json 组件版本解析与回退）；fmt / clippy 通过 |
| Server 全量测试 | 806 passed（+4：思考默认值 3、setup 路由版本字段 1） |
| Playwright Chromium 全量 | 60 passed（+1：组件不一致 → 直传同步组件；axe 与视觉相关断言全绿） |
| `npm run check:extensions` | 7 包 5 源一致 |

### 14.6 部署提醒（第四轮）

任务 14.2/14.3 改了 server 源码：出包前必须先 `cd server && npm run build`（§13.5 的坑：build-server-release.mjs 只打包既有 `.next`）。旧 `.asset.json`（无组件字段）的归档仍可检测，组件比对自动回退到桌面端编译期钉版。

## 15. 第五轮追加（2026-08-20）：消息管线修复、斜杠命令、ask_user 修复

按所有者五点反馈 + 两个参考客户端（Skitre/PiDeck、justhil/pi-app，均 MIT）调研落地。

### 15.1 合并分组在完成后消失（根因修复）

根因不在分组逻辑（`MessageView` 的 `isActivityOnly`/`groupMessages` 对快照与流式消息同样成立），而在 **SSE 断连丢消息**：Rust 建流从不带 `Last-Event-ID`（`src-tauri/src/streaming.rs`），服务端把每次连接当全新连接，断连窗口内已 finalize 的 message_end 永久丢失；活动消息丢失后连续 run 长度 < 2，分组合卡随之消失。修复两层：

- 传输层根治：`SseDecoder` 解析 `id:` 字段并跟踪游标（控制帧无 id 不动游标）；`AuthenticatedRequestSpec` 新增 `resuming_after`，agent 流重连时带 `Last-Event-ID` 恢复服务端 replay ring；`stop_agent_stream`（主动停止）清除游标避免旧事件重放。游标表按 StreamKey 存、上限 512 条（满了清空退化为快照模式）。
- 前端自愈：`replay_reset` 事件（服务端报告 gap/future）原先被静默丢弃，现在触发该会话的 `refreshDetail(quiet)` 快照补齐（pending 合并逻辑保留流式/乐观消息）。

### 15.2 运行状态闪烁（运行中→空闲→运行中）

根因：`submit()` 乐观置位后，SSE 建流（等 `connected`）+ prompt 到达服务端之间有窗口期，2.5s 轮询的 `setRunning(new Set(ids))` 整体替换把乐观状态冲掉。修复：`pendingRunsRef`（会话 → 30s 截止）登记本地待运行，三个整体替换点（`refreshSessions`/`refreshSessionsQuiet`/轮询）改走 `mergePendingRuns` 并集；`agent_start`/`prompt_done`/`agent_settled`/`prompt_error` 到达即清除标记；发送失败也清除。

### 15.3 斜杠命令补全与菜单重设计

- 内置命令从 4 个扩到 10 个：compact / reload / new / name / title / copy / export / fork / session / stop，全部本地实现（复用现有 `createSession`/`exportSession`/`autoNameSession`/`forkFromEntry`/`stopRemoteAgent`/统计面板）。pi TUI 的其余内建（settings/theme/hotkeys/quit 等）在桌面端无意义，不做。扩展/技能/提示词命令仍由服务端 `get_commands` 提供、按原文发给 SDK。
- 菜单按来源分组（命令/技能/提示词/扩展，组间分隔线 + 组标），命令名等宽 accent 色，上限 8→12 条可滚动，键盘导航自动 scrollIntoView；补 `role="listbox"/option` 与 aria-selected。

### 15.4 ask_user 修复（pi-ask 端到端打通）

根因：`@eko24ive/pi-ask` 的所有交互路径都门控 `ctx.mode === "tui"`，而 Server 以 `mode: "rpc"` 绑定扩展，工具直接返回"需要 TUI"文本。修复：

- Server：`rpc-manager.ts` 四处绑定改 `mode: "tui"`（已核实 SDK 仅把它透传给 `ctx.mode`；7 个捆绑扩展中只有 pi-ask 门控该值）。pi-ask 的 `runAskFlow` 由此走 `ctx.ui.custom`，命中 Server 已有的 headless custom UI 渲染器（`extension_ui_request {method:"custom", lines}`、关闭帧、`extension_ui_input` 命令、断线重放 pending 请求）。
- 前端：原先丢弃 `custom` 帧。新增 `customUis` 状态与 `CustomUiCard`（composer 上方、按会话隔离、ANSI 剥离、自动聚焦），键盘事件翻译为原始终端序列（方向键 `\x1b[A/B/C/D`、Enter `\r`、Esc `\x1b`、Tab、Backspace `\x7f`、可打印字符透传）经 `extension_ui_input` 回传；取消按钮发 Esc。
- e2e 新增「扩展 custom UI 渲染按键驱动并在关闭后消失」。

### 15.5 工具调用摘要行（借 PiDeck）

`ToolCall` 行预览从 raw JSON 改为智能摘要（按 `command/path/filePath/file/pattern/query/url` 顺序取首个字符串参数）；按工具名分类图标（bash→终端、read/write/edit→文件、grep/find/search→搜索、其余扳手）。

### 15.6 验证记录（第五轮）

| 范围 | 结果 |
| --- | --- |
| 根 lint / tsc / test:unit | 通过 |
| Rust | 69 passed / 1 ignored（+2：SSE id 游标、resume 清除）；fmt / clippy 通过 |
| Server 全量 | 807 passed（+1：tui 绑定断言） |
| Playwright Chromium 全量 | 61 passed（+1：custom UI 用例） |

### 15.7 部署提醒（第五轮）

15.1 的 Last-Event-ID 与 15.4 的 tui 绑定都改了 server 源码，目标机需重新构建出包部署（先 `cd server && npm run build`）；桌面端需重新 `npm run tauri build`。服务端 replay ring 早已存在，旧桌面端不带 `Last-Event-ID` 也能正常连接（只是回到快照语义），新旧端可交错。

## 16. 第六轮追加（2026-08-20）：增量拉取、本地缓存、版本升级工作流

### 16.1 会话记录增量拉取 + 本地缓存

所有者反馈"每次都要完整拉取"。会话本质就是 append-only 的 jsonl，已按此实现增量：

- **Server**：`GET /api/sessions/[id]` 新增 `after=<entryId>` 游标参数（窗口逻辑抽为 `server/lib/session-window.ts`，6 条单测）。游标命中则只返回其后的条目（`incremental: true`）；游标丢失（压缩/分支切换/文件重写）返回全窗口并标 `reset: true`，客户端整体替换。Rust 允许列表同步放行 `after`。
- **桌面端持久缓存**：`src/sessionCache.ts` 新增 localStorage v2 持久层（每会话尾部 120 条、最多 5 会话、800ms 防抖写、剥离 base64 图片与流式占位消息；旧 IndexedDB 持久层继续清理）。远端 jsonl 仍是唯一权威，本地缓存只加速打开。
- **水合路径**（`Workspace.tsx`）：有缓存时先秒开缓存，再 `refreshDetail(..., incremental=true)` 只拉增量合并；"加载更早"的扩窗仍走全量窗口（增量游标只能向前不能翻页）。

### 16.2 从 PiDeck / pi-app 吸收的健壮性改进

- 输入历史：composer 空输入时 ↑ 逐条回填本机已发送的 prompt（每会话 50 条），↓ 向前，任何编辑退出游走。
- Esc 中断运行（pi-app 惯例），仅在没有菜单打开时触发。
- 工具详情输入/输出渲染截断（20KB 上限），防止超长 toolResult 撑爆 DOM。
- 此前第五轮已落地：工具调用智能摘要行、分类图标、斜杠命令分组菜单。

### 16.3 版本升级工作流确立（所有者确认）

- Server 版本提升为 **0.0.2**（`server/package.json` + lock + `setup.rs` `PIHUB_SERVER_VERSION` 三处，`check-release-config` 通过；桌面端版本按约定保持 0.0.1 由发布流程提升）。**不改版本号时版本更新面板永远显示"已是最新"**——同码重部署仍需手动就地替换。
- 每次升级的固定链路：源码 tar 管道同步构建机（`ovh` 角色，无 rsync，stdin 方向可用）→ `npm run build`（必须带 `PIHUB_PORTABLE_BUILD_ROOT`/`TMPDIR` 指向 /root/tmp，§13.5 的 tmpfs 坑本轮又踩一次）→ `PIHUB_LOCAL_BUILD=1 node scripts/build-server-release.mjs` 出包 → 拉回桌面机 `release-artifacts/` → App 内「版本更新 → 直传安装」一键升级。`.asset.json` 现带 pi + 7 插件钉版，App 会逐组件对比显示。
- 版本更新面板报"未配置目录"=「连接设置 → 本地发布包目录」未填；填入桌面机 `release-artifacts` 绝对路径一次即可。

### 16.4 验证记录（第六轮）

| 范围 | 结果 |
| --- | --- |
| 根 lint / tsc / test:unit | 通过 |
| Rust | 69 passed / 1 ignored；fmt / clippy 通过 |
| Server 全量 | 813 passed（+6 session-window） |
| 发布脚本测试 | 93 passed（default-extension-bundle / verify-server-release 的版本断言改为从真实 manifest 读取，不再硬编码） |
| Playwright Chromium 全量 | 62 passed（+1 增量拉取用例） |
| 出包 | linux x64 0.0.2（dgn-01 与 ovh 各出一次，采用 dgn-01 产物） |

### 16.5 版本号提升的联动坑（本轮实踩）

升 `server/package.json` 版本时必须同步三处半：

1. `server/package.json` + `server/package-lock.json`（root 与 `packages[""]`）；
2. `src-tauri/src/setup.rs` 的 `PIHUB_SERVER_VERSION`（`check-release-config` 强校验一致）；
3. `extensions/package.json` + `extensions/package-lock.json`——**扩展 bundle 清单必须与发布版本同号**（`validateManifest` 的 `expectedVersion` 来自 server 版本），且改 lock 后必须重算 `scripts/default-extension-bundle.mjs` 的 `DEFAULT_EXTENSION_LOCK_SHA256` 审计钉值；
4. 相关测试里的版本字面量：`default-extension-test-fixture.mjs`（已改为默认读真实 manifest）、`default-extension-bundle.test.mjs`、`verify-server-release.test.mjs`（已改为 `SERVER_VERSION` 常量）。

### 16.6 构建机迁移：dgn-01

- 新构建机 **dgn-01**（linux x64，8C/7.8G）：node v22.23.2 装在 `/root/.local/share/pi-node/`（沿用 pi-node 布局），源码树 `/root/pihub-build`（tar-over-ssh 同步，机器无 rsync）。完整链路（npm ci → next build → 出包）约 2 分钟，远快于 ovh。
- **`setup.rs` 的 Linux node 哈希钉值修复**：`PIHUB_NODE_LINUX_X64/ARM64_SHA256` 原值与 nodejs.org 官方 SHASUMS256 不符（darwin 两条是对的），已按官方值修正——此前任何需要下载 node 的 Linux 全新安装都会在校验处失败。
- ovh → 桌面的 tailnet 链路传 293MB 实测极慢（分钟级仅 ~1MB），机器间/拉回大文件优先走 dgn-01。
- dgn-01 的 `/tmp` 也是 tmpfs（3.9G），构建仍需 `PIHUB_PORTABLE_BUILD_ROOT=/root/tmp/...` + `TMPDIR=/root/tmp`。

### 16.8 部署记录（第六轮，0.0.2 直装）

- 桌面机 tailnet 当日只有 DERP(hkg) 中转且吞吐 ~1KB/s（`tailscale ping` 无法建立直连），拉回本地发布包不可行；改为机器间直装：dgn-01 `python3 -m http.server --bind <CGNAT IP>` 供包（用完已 kill），seoul-amd-1/2 curl 拉取 + sha256 校验 + 手动渲染的 `standalone_bootstrap.mjs`（`PIHUB_LOCAL_ARCHIVE*` + `PIHUB_ALLOW_ROOT=1` + `PIHUB_AUTO_PAIR=0`）安装。两台均 `healthy, version 0.0.2`，旧版本目录保留可回滚。
- **注意**：桌面 App 的「直传安装」链路从 Mac 本地目录读包上传；Mac 侧 tailnet 恢复前，App 内升级大包子链路仍会卡在传输。本地 `release-artifacts/` 里目前**没有** 0.0.2 的 tarball（只有 asset 元信息也没拉），后续网络恢复后可从 dgn-01 的 `/root/pihub-build/release-artifacts/` 补拉。
- 包体积问题（293MB）已定位：onnxruntime-node 内含 ~170MB 非 linux 原生库、onnxruntime-web 130MB 在 Node 下纯死重、sharp musl 变体 17MB。裁剪方案待所有者拍板（见 §16.6 前一轮对话记录，预估可降到 ~120-140MB）。

### 16.9 内置默认发布包目录 + 桌面端替换（第六轮收尾）

- 所有者决策（自用）：`localReleaseDirectory()`（`src/lib.ts`）在设置为空时回落到内置默认 `/Users/zhangshijie/Documents/Project/pihub/release-artifacts`，连接设置里的输入框仍可覆盖。版本更新面板开箱即可检测。e2e 原"未配置目录"用例改写为"内置默认目录正常检测"。
- 桌面端已从最新 dmg 替换 `/Applications/PiHub Desktop.app`（dmg 打包后 `bundle/macos/` 下的 .app 会被消费掉，需从挂载的 dmg 里拷出；旧版备份为 `/Applications/PiHub Desktop.app.backup-20260820-231758`），启动验证正常。
- 注意：本地 `release-artifacts/` 只有 0.0.1 包，目标机已跑 0.0.2，面板会显示"已是最新"；下次出新版本（0.0.3+）时由 dgn-01 构建并拉回该目录即可在 App 内一键升级。

## 17. 第七轮追加（2026-08-21）：会话恢复、历史回填、ask 卡片、安装链路修复

按所有者截图反馈修复，全部过门禁并部署 0.0.3。

### 17.1 服务重启后会话"假空闲"（中断检测与续跑）

根因：RPC 会话跑在 server 进程内，服务重启即杀死所有进行中的 run，jsonl 最后一帧停在 user/toolResult。新增 `sessionInterrupted()`（`server/lib/session-reader.ts`，只读文件尾 64KB；尾部半行 JSON 也视为中断），`/api/sessions` 列表带 `interrupted`（运行中的会话恒为 false）。桌面端：侧栏/标签页琥珀色状态点（`.session-activity.interrupted`），会话顶部横幅"上次运行被中断…" + 「继续运行」（发送"继续" prompt，复用 pendingRuns 防闪烁）。

### 17.2 历史消息静默回填 + /reload 收缩修复

- Server `GET /api/sessions/[id]` 新增 `before=<entryId>` 反向翻页（`session-window.ts`，lost cursor 同样 reset）。
- 桌面端水合后**静默后台回填**：`prependOlder` 逐页向前拉直到完整（每会话一次，滚动位置按增量高度补偿）；`/reload` 保持当前已加载窗口大小（原先重置回 40 条）；"加载更早"按钮改走 before 分页。

### 17.3 ask/权限卡片体验（承接"又丑又卡"）

`CustomUiCard` 解析 TUI 帧：`(x) 选项` 行渲染为可点击按钮（点击即发送对应字母键，选中行 ▸ 高亮），payload  dump 超过 8 行折叠为"请求详情"，键位提示行去重。键盘路径保留。

### 17.4 更新链路的三个真 bug

- **插件 0/7**：facade 记录旧版本目录，升级后状态校验全失配。更新流程现在带全部默认插件重装（`DeviceSetup.tsx`），安装器增加"无显式选择时继承上次插件偏好"兜底（`standalone_bootstrap.mjs` effectivePackages）。
- **pi 版本"未知"**：打包后 `getPackageDir()` 解析到 .next 产物树；改为先读发布根 `node_modules/@earendil-works/pi-coding-agent/package.json`。
- **发现弹窗走 GitHub**：`App.tsx` 的 `localReleaseDir` 状态直读 localStorage 绕过了内置默认；改用 `localReleaseDirectory()`。弹窗加 `modal-body` 滚动区，超长日志不再把关闭按钮顶出视口。
- **本地发布包目录里的残缺包**（中断的传输留下无 .sha256 的 tarball）会让安装链路硬失败——传输中断后需手动清理，已在本轮清理。

### 17.5 验证与部署（第七轮）

- Rust 69 / Server 816（+9 session-window，含 before 翻页）/ 发布脚本 93 / Chromium 65 全过；lint/tsc/fmt/clippy 干净。
- dgn-01 出 0.0.3（含 §17.4 全部修复）。桌面端 dmg 已重打包并替换 /Applications（备份 `PiHub Desktop.app.backup-20260821-011219`）。
- Mac 侧 tailnet 仍只有 DERP 中转，0.0.3 tarball 未拉回本地 `release-artifacts/`（目录里只有 0.0.1 完整包）；恢复后从 dgn-01 `/root/pihub-build/release-artifacts/` 补拉。

### 17.6 0.0.3 直装实况（已于第八轮关闭，见 §18）

安装过程中踩了两个坑，均已处理/修复，**下次会话先确认两台机器的安装结果**：

1. **服务重启端口竞争**：安装器 `systemctl --user restart` 后旧进程释放 30141 较慢，新 supervisor 连续 EADDRINUSE 崩溃触达 systemd start-limit（默认 10s/5 次），健康检查失败并整体回滚到 0.0.2。修复：`renderSystemdUnit` 加 `StartLimitIntervalSec=0`（server/bin/pihub-server-install.js，bin 测试 66 条过）。手动把 current.json 指到 0.0.3 重启验证过：0.0.3 本身在 seoul-amd-2 上 ~6s 健康。
2. **同版本重装被拒**：第一次失败后 `versions/0.0.3` 残留，重建的 tarball 与其内容不完全一致，`sameRegularTree` 判 "Installed Server version conflicts"。处理：amd-1 直接删 `versions/0.0.3`；amd-2 先把 current.json 回指 0.0.2 并重启验证健康，再删目录。
3. **重试状态**：两台机器的重试**仍失败**，第二轮失败形态变为健康检查 20s 超时（"aborted due to timeout"，小内存机器启动慢；回滚正常，两台均已验证回 0.0.2 健康运行）。修复：`waitForHealth` 默认窗口 20s → 90s（`server/bin/pihub-server-install.js`，bin 测试 66 条过）。**下次会话**：先同步 server/bin 到 dgn-01 → 重建 0.0.3 → 重推渲染安装器（模板自上次渲染后还多了 effectivePackages 继承逻辑）→ 重试安装（tarball 已在两台 `/root/pihub-update/` 且校验过，重建后需重新下载校验）→ 按本节点 3 的清单验证。
4. 遗留清理：dgn-01 的 `python3 -m http.server 10086`（PID 19512/20707，如还在跑就 kill）；目标机 `/root/pihub-update/`（tarball + 渲染安装器，可留作下次用）；Mac 的 `/tmp/render-bootstrap.mjs`（安装器模板渲染脚本）与 `/tmp/ext-selection.b64`（全量插件选择）——手动安装复用方法见 §16.8。
5. seoul-amd-2 有 `state/current.json.bak-0.0.2` 备份；两台的 `versions/0.0.1*` 与 `0.0.2` 目录保留作回滚。

### 16.7 界面视觉深化（第六轮，承接"毫无差别"反馈）

第四轮只动了 token 层，观感太弱。本轮在截图对照下做了可见升级（全部纯 CSS，双主题）：侧栏选中会话 accent 底色 + 左侧条、项目名小号大写字距、会话标签页 accent 下划线、空会话 hero 蓝色光晕、模型标签 accent 圆点 chip、工具调用行 accent 图标块 + 10px 圆角、用户气泡软阴影、composer focus-within accent 描边光晕、模型/思考胶囊 999px 圆角、消息正文 14px/1.7、页面橙色光晕改品牌蓝。截图对照工具为临时 spec（用完即删）。

## 18. 第八轮追加（2026-08-21）：0.0.3 三台部署完成（§17.6 关闭）

按 §17.6 第 3 条的既定链路执行，seoul-amd-1、seoul-amd-2、dgn-01 三台全部 0.0.3 健康运行，插件 7/7，Tailscale Serve 就绪。

### 18.1 执行摘要

1. 本机源码树与 dgn-01 构建树全量哈希比对（server 的 `app/lib/bin` 320 个文件）：仅 `bin/pihub-server-install.js` 一个文件不一致，即 §17.6 的两处修复（`StartLimitIntervalSec=0`、健康窗口 90s），无遗漏改动。
2. 同步该文件到 dgn-01 → `npm run build` → `PIHUB_LOCAL_BUILD=1` 重新出包（292,956,728 B，sha256 以 dgn-01 `/root/pihub-build/release-artifacts/` 的 `.sha256` 为准），打包产物已 grep 确认含两处修复，`.asset.json` 组件版本齐全（pi 0.84.2 + 7 插件）。
3. 重新渲染安装器（渲染脚本的 `__MINIMUM_SERVER_VERSION__` 由 0.0.2 更正为 0.0.3，与 `setup.rs` 一致），分发到三台 `/root/pihub-update/`。
4. 两台 seoul 先删除残留的 `versions/0.0.3` 与旧 tarball，再经 dgn-01 的临时 http.server 拉新包（sha256 复核 OK）。
5. 安装结果：
   - **seoul-amd-1**：第一次安装健康但插件 0/7（见 §18.2 坑 1），带 `--with-extensions` 重装后 7/7；`versions/` 保留 0.0.2 可回滚。
   - **seoul-amd-2**：第一次因 user bus 缺失失败（见 §18.2 坑 2），回滚验证 0.0.2 健康后带环境变量重试成功；`versions/` 保留 0.0.1、0.0.1.bak、0.0.2 可回滚。
   - **dgn-01**：全新安装（该机此前无 pihub 服务），一次成功；Serve 手动挂载（见 §18.2 坑 3）；root linger 已开。
6. 清理：dgn-01 的 `python3 -m http.server 10086`（PID 20707）已 kill；三台 `/root/pihub-update/`（tarball + 渲染安装器 + 安装日志）保留备用。

### 18.2 本轮新踩的坑（手动安装必读）

1. **手动跑 `standalone_bootstrap.mjs` 必须显式带 `--with-extensions`**。不带参数时 `selectedExtensions` 是显式空数组，effectivePackages 继承兜底只在**上次偏好为 enabled** 时生效——而 §17.4 的 0/7 bug 恰恰把偏好写成了 `enabled:false`，继承结果就是继续 0/7。App 链路（DeviceSetup 更新流程）会显式传全量选择，不受影响；只有手动复现时要注意。
2. **tailscale ssh 非登录会话可能拿不到 user bus**：服务安装阶段报 "The current user's systemd manager is unavailable: Failed to connect to bus"，安装器整体回滚（已验证回滚干净）。修复：安装命令前加 `export XDG_RUNTIME_DIR=/run/user/0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus`，并先 `loginctl enable-linger root`。同一台机器不同会话表现可能不同（amd-1 不需要、amd-2 需要），手动安装一律带上。
3. **全新安装只跑 standalone 安装器不会配 Tailscale Serve**（挂 Serve 是 `bootstrap_unix.sh` 的职责，桌面 SSH 链路才有）。手动全新安装后需补 `tailscale serve --bg --https=30141 http://127.0.0.1:30141`。老机器重装不受影响（Serve 配置仍在）。

### 18.3 未关闭事项（增量）

- **dgn-01 尚未与桌面端配对**（三台均以 `PIHUB_AUTO_PAIR=0` 安装，避免配对码进日志/聊天记录）。需要时在 dgn-01 本机跑 `pihub-auth-admin issue` 拿一次性配对码，再到桌面端完成配对；seoul 两台沿用既有配对（凭据未动）。
- Mac 侧 tailnet 仍只有 DERP(hkg) 中转（`tailscale ping` 无法直连），0.0.3 tarball 仍未拉回本地 `release-artifacts/`（目录里只有 0.0.1 完整包）；恢复后从 dgn-01 `/root/pihub-build/release-artifacts/` 补拉，App 内「版本更新」面板即可正确显示三台状态。
- dgn-01 的 `/root/tmp/pihub-portable-0.0.3-r2` 构建暂存目录可随手清理。

## 19. 第九轮追加（2026-08-21）：pi-ask 卡片解析修复（纯前端）

所有者截图反馈 ask 卡片"解析有问题、点击可能一直循环"。根因：`parseCustomUiLines`（`src/Workspace.tsx`）只认 `(x) 选项` 行，而 pi-ask 实际帧是 `❯ 1. 选项` 编号格式（多选带 `[x]`、描述行固定 5 空格缩进、顶部 `← ☐ tab →` 标签栏、底部 ` · ` 分隔键位页脚、`─` 边框线）。解析失败时整帧塌进"请求详情"折叠区（截图 2 的空卡片），可点击按钮为零。

已按 pi-ask 源码（`extensions/node_modules/@eko24ive/pi-ask/src/ui/render-frame.ts` 等）确认的帧结构重写解析：编号选项（点击发对应**数字键**，即 pi-ask `numberShortcut` 语义，这是修复"循环"的关键——误发字母键会命中 pi-ask 的全局快捷键如 `t` 切换题型，造成点击后界面循环变化）、`[x]` 多选渲染为 ☑/☐ 前缀、描述行并入选项按钮、标签栏单独 muted 行、`─` 边框与键位页脚丢弃、`(x)` 旧格式保留兼容。选中行 ❯ 高亮保留。

验证：lint/tsc/test:unit 通过；Chromium 66 passed（+1 pi-ask 编号帧用例：3 选项、selected、描述、标签栏、页脚过滤、点击发 "2"）。纯前端改动，Server 不需重部署；桌面端已 `npm run tauri build` 并替换 /Applications（备份 `PiHub Desktop.app.backup-20260821-033923`），运行中实例需手动重启生效。

### 19.1 追加：模型错误长 JSON 撑破布局（同日）

所有者截图反馈：网关 503 的原始 JSON 错误文本（无空格超长串）把错误卡片和整个会话框撑宽。修复（纯 CSS）：`.provider-error` 补 `min-width: 0; overflow-wrap: anywhere`（flex 容器内裸文本节点的 min-content 宽度会把布局顶开），`.custom-message` 补 `overflow-wrap: anywhere`。新增 e2e「模型错误长 JSON 不撑破消息区」（断言 message-scroll 与卡片均无横向溢出）。Chromium 67 passed；桌面端已重打包替换（备份 `PiHub Desktop.app.backup-20260821-035050`），运行中实例需重启生效。

## 20. 第十轮追加（2026-08-21）：Windows（desktop-fr）0.0.3 部署 + Windows 构建链修复

所有者要求给 Windows 机 desktop-fr 装 pi-server + magic-context 补丁（即 0.0.3 的 latch 修复，随 server 部署）。Windows 直传链路未实现，改为在 Windows 本机完成「源码同步 → npm ci → next build → 出 win32-x64 包 → standalone 本地模式安装」全链路，最终 **0.0.3 健康运行**（Task Scheduler 服务 + Tailscale Serve 就绪，server-only 安装未触碰用户既有 pi 配置）。Windows 构建环境保留在 `C:\pihub-build`（源码树 + 依赖 + release-artifacts），可重复出包。

### 20.1 本轮修复的 Windows 平台真实 bug（均已过门禁）

1. **npm .cmd shim 无法 spawn**：CVE-2024-27980 后 Node 禁止无 shell 直接 spawn `npm.cmd`（EINVAL），`build-server-release.mjs` 与 `default-extension-bundle.mjs` 在 Windows 上全部 npm 调用失败。修复：`secure-npm-environment.mjs` 新增 `npmSpawnInvocation()`——win32 下改为用当前 node 直接执行 `<node_dir>/node_modules/npm/bin/npm-cli.js`（path 操作用 path.win32，跨平台可测）。脚本测试 95→96。
2. **win32 隐私审计登记**：win32 暂存树新增 4 个 server 树原生二进制审计条目（swc/node-pty conpty×2/clipboard，嵌入上游 CI 构建路径，sha256 钉死，与 linux dylib 同类），扩展树新增 17 条（fff_c.dll、ffi-rs、AWS SDK 类型文档示例占位符、@types/node 等，同类误报）。`server-resource-privacy.mjs` 新增 `isAuditedServerStagingPrivacyFinding`（暂存树用）与 `isAuditedServerStagingArchiveFinding`（归档级用——**归档扫描只物化语义文件，原生二进制不在盘上，必须用流式成员哈希比对**，这是第二次踩出来的差别）；`build-server-release.mjs` 与 `verify-server-release.mjs` 两处过滤都接上。
3. **管理员安装放行**：所有者明确决策（同 PIHUB_ALLOW_ROOT 的自用逻辑），ps1 管理员拒绝改为 `PIHUB_ALLOW_ADMIN=1` 显式放行；`standalone_bootstrap.mjs` 的 `sanitizedChildEnvironment` 白名单同步加入。**关键细节**：检查必须是安装期专属（`-RunServer` 豁免）——计划任务无法继承环境变量，运行期检查会让服务每次启动自杀。此 bug 靠手动注册调试任务 + cmd 重定向抓输出才定位（任务计划下 ps1 的错误不进任何日志）。
4. extensions 的 `npm ci` 在 Windows 需 `--legacy-peer-deps`（magic-context peer 钉版冲突，与 linux 一致）。

### 20.2 Windows 运维事实（本轮踩过的坑）

- Windows OpenSSH 默认 shell 是 PowerShell：命令用 `;` 不用 `&`；`$env:X\path` 要写 `${env:X}\path`；ssh 层会吃掉 `$false` 等 `$` 变量，需 `\$` 转义；多跳引号（ssh→PowerShell→cmd）极易崩，超过一层就写 .ps1 文件 scp 过去执行。
- 调试计划任务：Interactive logon 的任务在目标用户有活动 console/RDP 会话时可跑；任务输出要用 `cmd /c "... > log 2>&1"` 捕获，`*>` 追加在 -Argument 里会被当成脚本位置参数。
- `Stop-Process -Force` 按进程名批量杀 node 会误杀正在跑的构建（本轮误杀一次出包）。
- Mac 侧 Tailscale DNS 关闭 + DERP 中转时，curl 验证 Serve 域名不通属预期，以目标机 loopback 健康 + serve status 为准。
- desktop-fr 环境：node v22.22.0/npm 10.9.4 已预装；数据根 `%LOCALAPPDATA%\PiHub\Server`；Administrator 有活动 console 会话（Interactive 任务可运行）；磁盘 1.1TB。

### 20.3 未关闭事项（增量）

- desktop-fr 未做插件 provisioning（所有者要求 server-only，其 pi 配置自行管理）；magic-context latch 修复在 server 侧，对该机用户自配的 magic-context 同样生效。
- Windows 构建机 `C:\pihub-build\collect-findings.mjs`、`register-debug-task.ps1`、各阶段日志可随手清理；dgn-01 的 `/root/win-build/` 及 http.server（已 kill）。
- Mac 的 `release-artifacts/` 仍无 0.0.3 tarball（含 win32 包也拉不回来，DERP 瓶颈）；App 内「版本更新」对 Windows 设备暂不可用（直传链路未实现，需补 `bootstrap_windows.ps1` 的 stdin 归档路径）。

### 20.4 追加：权限 ask 双帧循环（同日，纯前端）

所有者截图反馈权限卡片在两个帧之间"一直循环"。根因：`@gotgenes/pi-permission-system` 的选中行标记是 `▶`（U+25B6），不在 §19 解析器的固定标记字符集里——选中行因此匹配失败退化为纯文本。该扩展的 doublePressToConfirm 流程要求"同一热键按两次确认"：点击 (s) 进入 armed 帧后，(s) 行变成不可点击的文本，用户永远无法用鼠标完成第二次确认，只能在 y/s 之间反复 armed，视觉上就是两帧无限乒乓。修复：标记组从固定字符集改为任意单个非字母非数字符号（`[^\p{L}\p{N}\s]?`，unicode 感知，避免把"见 1. xxx"这类中文上下文行误判为选项），编号/字母两种选项行同样处理。新增 e2e「权限系统双帧：任意选中标记行可点击，双击确认不卡循环」（▶ 行解析为按钮、armed 帧保留提示行、连点两次发两个 s）。Chromium 68 passed；桌面端已重打包替换（备份 `PiHub Desktop.app.backup-20260821-091100`），重启 App 生效。

### 20.5 追加：钥匙串凭据合并存储（同日，Rust）

所有者反馈"有几个凭证就要输入几次密码"。根因：macOS 按**钥匙串条目 × 二进制签名**控制访问弹窗，原先每台设备一条 `origin-*` 条目，每次重打包（cdhash 变化）N 台设备弹 N 次。修复（`src-tauri/src/credentials.rs`）：全部设备凭据合并为单一条目（`devices-v2`，`{version, credentials: {origin: StoredCredential}}`），读取整条入内存缓存——每次运行最多弹一次。旧逐条条目改为**惰性迁移**（合并库未命中才读旧条目并并入，不删旧条目避免额外弹窗；删除凭据时新旧两条都删，防止迁移路径复活已删凭据）。新增 3 条纯函数测试（roundtrip / 版本拒绝 / 畸形拒绝）。Rust 71 passed / 1 ignored，fmt/clippy 干净；已重打包替换（备份 `PiHub Desktop.app.backup-20260821-094930`）。注意：每台设备的**最后一次**旧条目读取仍会各弹一次（迁移不可避免），此后稳定为一次；跨重打包若想零弹窗需正式签名身份。

### 20.6 追加：Windows 会话认领 + 底部跟随滚动竞争（同日）

- **Windows 会话/文件空白**：desktop-fr 的 75 个历史会话是用户自己 pi CLI 产生的未归属会话，按设计被 sessions API 隐藏（与第二轮目标机 A 相同）。已在该机执行 `pihub-auth-admin claim-sessions --input '{"deviceId":"dev_...","claimAllUnowned":true}'` 全部认领。文件面板空白同理需要在 App 内授权工作区根（allowed-roots 从空开始，属预期流程，非 bug）。
- **底部一直往上跳**：`storeDetail` 的 rAF 滚动与 React 提交竞争——rAF 在提交前量到旧 scrollHeight，底部跟随永远贴不住（距离超 140px 阈值后 follow 关闭，用户被越甩越靠上）；静默回填 prepend 的高度补偿同样失准。修复：滚动意图（follow / prepend 补偿）改为在调用点记录到 ref，由 `useLayoutEffect` 在提交后按真实 DOM 高度统一应用；prepend 补偿优先于底部跟随；恢复记忆位置时不触发跟随（避免一帧闪烁）。新增 e2e「底部跟随时连续新消息保持贴底」。Chromium 69 passed；已重打包替换（备份 `PiHub Desktop.app.backup-20260821-101744`）。另：本次 dmg 打包曾被一个 detach 失败的残留 rw 镜像卡死（bundle_dmg.sh 失败），`hdiutil detach` 对应 /dev/diskNsM 后重跑即可。

## 21. 第十一轮追加（2026-08-21）：Windows「Agent request failed」根因修复

所有者反馈 desktop-fr 发消息报 Agent request failed。该报错是 `/api/agent/new` 与 `/api/agent/[id]` 路由对所有异常的笼统 500 包装（原先不留任何日志），定位过程本身踩了一串坑，全部记录如下。

### 21.1 根因链（逐层剥离）

1. 真实错误（dev 实例日志）：`OutboundRequestError: unsupported_transport`，在 SDK prompt 预检 `checkAuth("unknown")` 处抛出——**会话没有可用模型**（provider 占位符 "unknown"）。
2. 没有模型的原因：该机的 NewAPI Provider（hdddefault/ccload/ai）虽经 `provider-newapi.json` 正常注册，但运行时**模型目录为空**——目录来自网关发现（`/v1/models`）或 models-store 缓存指纹匹配；Windows 上发现需要 API Key，而 `auth.json` 里只有 `ai` 一家有凭据，且运行时装机 `allowNetwork=false` 只靠缓存，缓存指纹与当前 config 不匹配即为空。
3. 修复（全部在这台机器本机完成）：把 `ai` 的 api_key 复制给 hdddefault/ccload/local（**先验证过同一个 key 在两个网关都有效**，网关均列出目标模型），再经 `POST /api/pihub/newapi {action:"refresh", name}` 强制联网刷新并把目录持久化到 models-store.json。生产实例复测：`agent/new` 默认模型与 hdddefault/gpt-5.6-terra 均 200（模型 hdddefault/glm-5.2-fast）。
4. 对比验证：同一探针在 seoul-amd-1 一次成功，证明不是 Server 版本问题而是机器级配置问题。

### 21.2 诊断方法论（下次直接照用）

- 自建探针（已删除）：`pihub-auth-admin issue` + loopback claim 拿一次性 throwaway 设备，按 `pihub-request-v3` 自签名调任意 API（sessions 按 owner 隔离，探针设备看不到用户会话属预期）；用完 `revoke`。
- 看真实错误：在 Windows 构建树（`C:\pihub-build\server`）跑 `npm run dev:headless -- -p 30199`（注意 ssh 会话结束整棵进程树被杀，需同一会话内完成起服+探测+读日志）。
- 已沉淀到源码的改进：两个 agent 路由在吞错前 `console.error(error.message)`（仅 message，避免路径/主机进日志；生产 stdout 被任务计划丢弃，主要服务 dev 诊断）。server 816 测试全过。

### 21.3 运维坑（新增）

- **Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM**，JSON 解析器直接瞎掉（报 "Unexpected token '?'"），且错误文案指向无关的 provider（ant-ling，按字母序第一个），极具迷惑性。写 JSON 用 `[IO.File]::WriteAllText($p,$json,(New-Object Text.UTF8Encoding($false)))`。
- ssh 命令里的 `$(Get-Date ...)` 会被本地 bash 先吃掉（备份因此没建成），PowerShell 变量/子表达式一律 `\$` 转义或写脚本文件。
- models-store.json 的缓存按 `newapiFingerprints`（origin 指纹）匹配，config 一变指纹不匹配缓存即作废，`allowNetwork=false` 的运行时不会自愈，必须走一次 `action:"refresh"`。
- `local` 与内置 Provider 同名冲突，NewAPI 扩展会跳过注册（config 里有也用不了）。

### 21.4 遗留

- **ccload 刷新仍 400**：`cl.hdd.sb` 不接受 ai 的 key（需它自己的 key）。所有者若用 ccload，在 App「模型管理 → NewAPI」里给它单独配 key 后刷新即可。
- desktop-fr 的 `auth.json` 被本轮修改（原状：仅 `ai` 一家；现 hdddefault/ccload/local 为同一 key 的副本）；原文件无备份（PowerShell 转义坑），如需还原删掉那三个键即可。
- 探针创建的 4 个测试会话文件（turnstile 目录下）归已吊销的 throwaway 设备，对所有者不可见，可留可删。
- 路由错误日志改进在源码，随下个版本（0.0.4+）进发布包；当前三台 Linux + Windows 生产实例均不含，仅影响诊断便利性。

## 22. 第十二轮追加（2026-08-21）：pi launcher 静默失效 + 会话缓存限额

### 22.1 Windows 上 `pi` 命令"没了"（全平台潜伏 bug）

现象：desktop-fr 上输入 `pi` 无任何输出直接返回。根因链：

1. standalone 安装器的 `installPiLauncher` 把 `pi` shim（Windows：`%APPDATA%\npm\pi.cmd/pi.ps1`）指向 `bin/pi-launcher.mjs`——它**覆盖了用户自己 npm 全局 pi 的同名 shim**。
2. `pi-launcher.mjs` 用 ESM `import()` 加载 `runtime-entry.js`，而后者只在 `require.main === module` 时才执行——ESM import 下 `require.main` 为 undefined，于是**静默 no-op 退出 0**（已用小实验复现）。
3. Linux 三台同样坏，只是 `pi` 被 pi-node 的全局安装挡在前面，一直没暴露。

修复：`runtime-entry.js` 增加 `process.env.PIHUB_STANDALONE_LAUNCHER === "1"` 放行（launcher 注入该标记；无标记保持惰性，Next supervisor 的 require 不受影响）；`standalone_bootstrap.mjs` 的 `piLauncherSource` 生成时写入标记。测试：`runtime-entry.test.mjs` +2（标记 import 到达 pi、无标记 import 保持惰性）。Windows 已重出包（第 9 次）并重装，`pi --version` = 0.84.2 正常。Linux 机器的 shim 会在下次安装时自动更新（当前由 pi-node 的 pi 顶着，无感）。

注意：Windows 重装前必须**先停计划任务再删 `versions\<version>`**——运行中的 node 锁文件，`Remove-Item` 静默失败会导致 sameRegularTree 冲突报 "Installed Server version conflicts"。

### 22.2 会话本地缓存"每次都要重新获取"

最可疑根因：**localStorage 配额静默溢出**。持久层每条消息没有大小界，几个大 toolResult 就把 ~5MB 配额打爆，`setItem` 抛异常被 catch 静默吞掉——缓存永远写不进去，每次开会话都全量拉取。修复（`src/sessionCache.ts`）：持久化前逐块截断（text/thinking/output 8KB、input/arguments 序列化后 8KB 占位），写失败时先清空其它会话的持久项再重试一次。新增 e2e「超大工具输出不撑爆本地缓存，重开仍从缓存恢复」（~2MB 工具输出 → reload 后缓存命中）。Chromium 70 passed，桌面端已重打包替换（备份 `PiHub Desktop.app.backup-20260821-120512`）。

### 22.3 本轮验证

- server 818（+2 runtime-entry）/ 安装器 21 / 根 lint、tsc、单测 / Chromium 70 全过。
- Windows：win32 包 sha256 `338dd6ad…`，重装后健康；`pi` 正常；agent 请求正常（承接 §21）。

## 23. 当前基线（2026-08-21 收盘，下一位维护者先读这里）

### 23.1 机队状态（全部已验证健康）

| 机器 | 平台 | Server | 插件 | 说明 |
| --- | --- | --- | --- | --- |
| seoul-amd-1 | linux x64 | 0.0.3 healthy，Serve 就绪 | 7/7 | 回滚件 versions/0.0.2 |
| seoul-amd-2 | linux x64 | 0.0.3 healthy，Serve 就绪 | 7/7 | 回滚件 0.0.1*/0.0.2 |
| dgn-01 | linux x64 | 0.0.3 healthy，Serve 就绪 | 7/7 | 全新安装；构建机（`/root/pihub-build`） |
| desktop-fr | windows x64 | 0.0.3 healthy，Serve 就绪 | server-only（用户自管 pi 配置） | 构建机（`C:\pihub-build`）；Task Scheduler 服务 |

四台均已完成与桌面端的配对（dgn-01、seoul-amd-2 本轮用 `pihub-auth-admin issue` 手工签发配对码完成；desktop-fr 同法）。desktop-fr 的 75 个历史会话已 `claim-sessions` 认领；agent 请求、模型目录（ai/hdddefault 各 11 个模型）、`pi` 命令均验证正常。

### 23.2 桌面端

`/Applications/PiHub Desktop.app` 当前构建 = 第十二轮（ask 双帧循环修复 + 钥匙串合并存储 + 底部滚动修复 + 会话缓存限额），备份链最新为 `PiHub Desktop.app.backup-20260821-120512`。钥匙串已迁移到单条目 `devices-v2`（每台设备最后一次读旧条目仍会各弹一次属预期）。

### 23.3 版本与构建

- Server 0.0.3 / Desktop 0.0.1。linux x64 包在 dgn-01 `/root/pihub-build/release-artifacts/`，win32 x64 包在 desktop-fr `C:\pihub-build\release-artifacts\`。
- 出包链路（两轮都验证过）：同步源码（注意先哈希比对，见 §18.1）→ `npm run build`（server）→ `PIHUB_LOCAL_BUILD=1 node scripts/build-server-release.mjs --platform <p> --arch <a>` → 渲染安装器（`/tmp/render-bootstrap.mjs`，MINIMUM 版本号要随 `setup.rs` 更新）→ 手动安装命令见 §16.8/§18.2（务必 `--with-extensions`、bus 环境变量、停服再删旧版本目录）。
- Mac 本地 `release-artifacts/` 仍只有 0.0.1 包（tailnet DERP 瓶颈，0.0.3 拉不回来），App 内「版本更新」面板暂时显示"已是最新"。

### 23.4 未关闭事项（汇总，取代 §18.3/§20.3/§21.4 的分散记录）

| 优先级 | 事项 |
| --- | --- |
| P1 | **ccload 未配好**（desktop-fr）：`cl.hdd.sb` 不接受 ai 的 key，需单独配 key 后 NewAPI 刷新。 |
| P1 | Mac 侧 tailnet 只有 DERP 中转且 Tailscale DNS 关闭：大文件拉不回、Serve 域名直连不通；恢复后从 dgn-01 补拉 0.0.3 tarball 到 `release-artifacts/`。 |
| P1 | Windows 直传更新链路未实现（命令层拒绝）；desktop-fr 升级目前只能本机出包 + 手动安装（§22.1 注意先停服务再删旧版本目录）。 |
| P2 | 会话缓存限额修复（§22.2）待所有者实际使用确认；若仍全量拉取，改查增量游标 reset（compaction 重写）路径。 |
| P2 | desktop-fr 的 `auth.json` 被改过（原仅 `ai`；hdddefault/ccload/local 为同 key 副本，无备份，还原即删三键）；探针遗留 4 个测试会话文件可留可删。 |
| P2 | `local` 与内置 Provider 重名，NewAPI 扩展不会注册（config 里有也用不了）。 |
| P3 | README/docs/release.md 仍描述 GitHub 分发为主路径（沿袭第二轮）；`/Applications` 下历史备份 app 未清理；dgn-01 `/root/win-build/`、`/root/tmp/pihub-portable-*` 可清理。 |

### 23.5 工作区源码状态（本轮全部已落源码并过门禁）

- 发布/构建链：`npmSpawnInvocation`（win32 npm-cli.js 调用）、win32 隐私审计登记（暂存树 4 条 + 归档流式哈希校验 + 扩展树 17 条）、`PIHUB_ALLOW_ADMIN=1`（安装期专属，运行期豁免）。
- Server：`runtime-entry.js` launcher 标记放行；agent 路由吞错前记 message 日志。
- 桌面端：pi-ask 编号帧解析 + 任意标记符号、错误卡片长串断行、钥匙串单条目合并、底部滚动提交后应用、会话缓存逐块截断 + 配额重试。
- 最新门禁：server 818 / 安装器 21 / runtime-entry 8 / 脚本 96 / Rust 71+1 ignored / Chromium 70 / 根 lint、tsc、单测全过；`npm run check:extensions` 7 包 5 源一致。

## 24. 第十三轮追加（2026-08-21）：会话缓存落盘、首页行式重设计、edit diff 渲染

纯桌面端改动（前端 + Rust），Server 与部署均不涉及；桌面端需 `npm run tauri build` 后替换 /Applications。

### 24.1 会话缓存从 localStorage 改为分设备文件

所有者反馈"缓存不要用 localStorage，分设备分文件夹记录"。新增 Rust 模块 `src-tauri/src/session_cache.rs`：`read/write/delete/clear_session_cache` 四个命令，缓存落在 `app_config_dir()/session-cache/<deviceId>/<sessionId>.json`——每台设备一个文件夹、每会话一个 JSON 文件，原子写（临时文件 + rename）、0o600/私有 ACL、拒绝符号链接、单文件 4MB 上限、每设备按 mtime 只保留最新 8 个会话。`src/sessionCache.ts` 持久层改走这些命令（800ms 防抖不变；内存 LRU 不变），并一次性清掉旧的 `pihub-session-v2:*` localStorage 项（IndexedDB 与更早的 legacy 清理逻辑保留）。注意一个实际踩到的坑：`readCachedSession` 命中磁盘时**必须回填内存层**——增量游标的 anchor 由 `peekSession`（仅内存）读取，否则重开后退化为全量拉取。e2e mock（desktopMock）的缓存命令用 localStorage 做后端以撑过 `page.reload()`（仅测试桥，与真实实现无关）。

### 24.2 首页行式重设计 + 单设备刷新

- 设备卡片改为紧凑行（`.device-card` 类名保留以兼容 e2e）：图标 + 名称/host + 行内统计（状态/延迟/版本）+ 操作（**单设备刷新**、收藏、菜单）+ 连接按钮，一行一设备；`add-card` 同步改为紧凑行。hero 区收敛（标题 34→24px，文案与间距收紧）。窄屏（≤800px）隐藏统计列，≤520px 连接按钮独占一行。
- 单设备刷新按钮 `aria-label="刷新 <名称> 状态"`，只 probe 该设备、其余设备状态不变；检查中禁用并转圈。hero 字号断言与 e2e 选择器已同步更新。

### 24.3 edit 工具调用 diff 渲染

所有者反馈"没有处理 edit"。pi 的 edit 工具结果自带 `details.patch`（unified patch）与 `details.diff`，原先前端只把整段 JSON 参数 dump 进"输入"。现在 `src/MessageView.tsx`：edit 类工具行尾显示 `+A −D` 计数徽标，展开详情渲染着色 diff（绿增/红删/蓝 hunk，400 行截断），无 `details`（pending/旧会话/失败）时回退用入参 `edits[]` 的 oldText/newText 逐行对照；出错时仍附原始结果文本。

### 24.4 验证记录（第十三轮）

- 根 lint / tsc / test:unit 通过；Rust 75 passed / 1 ignored（+4 session_cache：段名校验、原子写读删、symlink 拒绝、按设备淘汰）；fmt / clippy 0 warning。
- Playwright Chromium 全量通过（含新增 3 条：单设备刷新断言扩展、edit patch diff、edit 无 details 回退）。

### 24.5 借鉴 Kimi Code Web UI 的体验项（同日）

对照 kimi code webUI（明/暗截图 + 设计 token）落地五项，均纯前端：

- **工具行右端成败标记**：非分组的工具行右端绿 ✓ / 红 ✕（`.tool-verdict`），结果未回时不显示；分组行沿用状态点。
- **composer 运行中提示**：底部 hint 行运行中切换为「Enter 插话打断当前生成 · Esc 中断运行」（ steer 语义原先只在 placeholder 里）。
- **图片网格 + caption**：连续 image block 折叠进 `.image-grid`，每图带 `image/png · 32 KB` 说明行（`MessageImage` 改 figure/figcaption，大小由 base64 长度估算）。
- **diff 颜色 token 化**：新增 `--diff-add-bg/--diff-del-bg`（明暗双主题），`.diff-line` 引用；等宽字体栈加入 JetBrains Mono 首选。
- **侧栏相对时间紧凑化**：`relativeTime` 从「N 分钟前/小时前/天前」改为「刚刚 / N 分钟 / N 小时 / N 天 / N 周」。

未采纳：git 分支+增删行 chip（所有者明确排除）、onboarding wizard、登录态。

### 24.6 桌面端部署（第十三轮）

- `npm run tauri build` 出包时 dmg 打包再次被残留的 rw 镜像卡死（§20.6 同款坑）：detach 掉 1 个挂载残留（/dev/disk4）+ 删掉 5 个 `rw.*.dmg` 临时镜像；因 dmg 失败，`bundle/macos/` 下的 .app 未被消费，直接用它替换。
- 已替换 `/Applications/PiHub Desktop.app`（备份 `PiHub Desktop.app.backup-20260821-140725`），启动验证运行中。
- **桌面图标问题**：排查结论是 icon.icns 本身无问题（SVG 源带 9% 内边距，渲染正常，与部署文件哈希一致）——用户侧看到的是 macOS 图标缓存陈旧（多轮原地替换 .app 导致）。已 `touch` + `lsregister -f` + `killall Dock` 强制刷新。若重启 Dock 后仍显示旧图标，重启 Finder 或注销重登即可。
- **追加**：第一轮刷新后 Launchpad 仍显示「?」角标（路径未变但引用陈旧）。二轮处理：`lsregister -u` 注销再 `-f -v` 重注册、删 `~/Library/Caches/com.apple.iconservices.store`、`killall Dock` + `killall Finder`，验证 bundle id 注册正常、Finder 可启动。若仍不消失，核选项是 `defaults write com.apple.dock ResetLaunchPad -bool true; killall Dock`（会重置 Launchpad 文件夹布局，需所有者同意）。

### 24.7 传输层韧性修复（同日，desktop-fr 超时报告）

所有者报告 desktop-fr 一直报 `error decoding response body → request or response body error → operation timed out`。排查事实：

- 该错误是 reqwest 的 30s 总预算在**读 body 中途**耗尽——连接与 header 已到，body 卡住。
- 事发时 Mac 侧 tailnet 正经历网络切换（netcheck 日志 "gateway and self IP changed"），全部节点只能走 DERP 中转、直连建立失败；DERP 会无 RST 静默丢弃空闲连接，连接池（idle 300s）里的死连接被复用后读 body 就永远卡死。
- 复测（冷热各三次）：fr 健康端点冷 13s / 热 1.8–2.8s，服务端本身无异常。

修复（`src-tauri/src/transport.rs`，纯桌面端）：`agegr_request` 的 GET 请求在 body 读取失败时 `invalidate_tailnet_client` 丢弃整个连接池并重试一次（GET 幂等，重试安全；POST/流不重试）；连接池 `pool_idle_timeout` 300s → 60s。Rust 75 passed / clippy / fmt 干净；已重打包替换 /Applications（备份 `PiHub Desktop.app.backup-20260821-143123`）。

遗留：Mac 侧 tailnet 直连打不通 + DERP 分配次优（最近节点测出 Denver 211ms）是网络层问题，应用层只能兜底；若 fr 仍报错则下一步上机查 Serve/服务本身。

### 24.8 大会话"一直获取不到"根因修复（同日，已部署 desktop-fr）

所有者反馈 fr 上 42,764 条消息的会话一直拉不开。根因**不是** 24.7 的网络层：实测 43k 条目（89MB jsonl）在 fr 全量解析仅 ~850ms，真正的问题是**每个请求都全量解析**——桌面端 2.5s 轮询 + 后台回填分页，每个请求都重新 `SessionManager.open`（详情路由）或每 30s TTL 到期后重扫全部 165 个会话文件（列表路由，`SessionManager.listAll` 逐行解析每个文件，实测冷扫 4783ms），单线程事件循环被长期占满，请求全部撞上 30s 总预算。

修复（`server/lib/session-reader.ts`，纯 Server 侧，其它机器待下次发布）：

- **`openSessionManagerCached`**：会话文件 append-only，按 `(path, size, mtimeMs)` 缓存 `SessionManager` 实例（LRU 3，实例持有全部解析结果，内存敏感）；详情/上下文/thinking 路由全部改走缓存。冷 847ms → 热 0ms。
- **会话列表逐文件缓存**：不再调 SDK 的 `SessionManager.listAll`（每次全量流式解析所有文件），改为自实现 `scanSessionFileRecords`（同样语义、同样枚举、并发 10、不保留 `allMessagesText`——服务端从不消费它），逐文件按 size+mtime 缓存（上限 500）。冷 4783ms → 热 12ms。
- 测试 seam：列表加载的三个既有测试从 stub `SessionManager.listAll` 改 stub 新导出的 `sessionFileScannerRef.scan`；新增 2 条（size+mtime 缓存命中/追加失效、manager 缓存复用/追加重载）。
- 实测（fr 本机，修复后代码）：扫描冷 4783ms/热 12ms；43k 会话打开冷 847ms/热 0ms。

验证：server 820/820（+2 新用例，含 runtime-route 源码断言同步）、lint/tsc 干净。部署 fr：构建树同步 3 个文件 → `npm run build`（portable）→ 停「PiHub Server」计划任务 → 就地替换 `versions\0.0.3\.next`（旧目录 `.next.bak-20260821` 可回滚）→ 启动健康检查通过。**坑**：产物里导出名被 minify，预检 grep 要找全局字符串 `__piSessionManagerCache` 而不是函数名。

未做：版本号未提升（同码就地更新，沿袭既有惯例）；三台 Linux 机器待下次出包带上此修复。

### 24.9 追加：发送阶段的死池化连接重试（同日）

24.8 部署后所有者复测 43k 会话仍报超时，错误变为 `error sending request for url (.../api/models?...) → operation timed out`（发送/等头阶段）。在 fr 本机逐段计时详情路由全链路（open 796ms / getEntries 4ms / getTree 53ms / buildSessionContext 59ms / 序列化 541KB），全部 < 1s；models 冷加载 ~3s——服务端无热点。结论：剩余失败是连接池里的死连接在**发送阶段**卡住（写进内核缓冲成功、永远等不到响应头，30s 预算耗尽），24.7 只覆盖了 body 读取阶段。修复：`send_authenticated_attempt` 对 GET/HEAD 在 `is_timeout()` 时同样丢弃池化客户端重试一次（POST 绝不自动重试，防双发）。Rust 75 passed；已重打包替换 /Applications（备份 `PiHub Desktop.app.backup-20260821-161323`）。**复测口径**：若仍失败，下一步在 fr 用 `pihub-auth-admin issue` + `pihub-sign-request.js` 搭签名探针实测各端点延迟。

### 24.10 网络层根治：自建 DERP + mihomo 绕过 + 强制 gzip（同日晚）

所有者反馈修完后仍"一直获取不到"。逐层剥离后的完整根因链：

1. **Mac 的 Clash Party（mihomo）TUN 劫持了 tailscale 流量**：`route get <derper IP>` 走 utun1500；STUN/UDP 被吞（netcheck `UDP: false`）→ 直连永远建立失败；DERP TCP 连接也被代理链剥皮。绕过落在两个持久位置（都有备份）：覆写脚本 `~/Library/Application Support/mihomo-party/override/substore-good-rules.js`（`tun.route-exclude-address` + `rules` 前置 DIRECT，注意运行时 config.yaml 的 tun 段**不由覆写脚本决定**）与 app 模板 `mihomo-party/mihomo.yaml`（tun 的 route-exclude 必须改这里才生效）。三个自建中继 IP 全部加入。
2. **自建 DERP**：官方把 Mac 分到 Denver（211ms）且拥塞（2MB scp 4 分钟传不完）。所有者自建 derper（阿里云 47.109.23.44:14198，derpMap region 901，`OmitDefaultRegions`）；本轮在 tokyo-amd-1（138.2.4.80，region 902）与 seoul-amd-2（193.123.231.93，region 903）各部署一份（derper v1.102.3，Mac 交叉编译 `GOOS=linux go build tailscale.com/cmd/derper`，systemd unit `-a :14198 -stun-port 22345`，iptables 放行；Oracle 安全组原本已通）。绕过后 relay ping 从 2-4s 降到 248ms 稳定。链路矩阵：Mac→阿里云 30ms / →首尔 330ms / →东京 1100ms；中继→fr 均 ~250ms。
3. **Serve 剥掉 Accept-Encoding**（Go ReverseProxy 行为）：fr 本机回环响应有 gzip，经 Serve 后没有。修复：`server/lib/session-access.ts` 的 `privateSessionJson` 对 >1KB 的 JSON 主动 gzip 并显式设置 content-encoding（代理对**已编码**的响应原样透传；reqwest 端 gzip feature 本来就开着）。43k 会话首屏 541KB → 约 50KB。
4. **踩的坑**：swap 预检 grep 别找会被 minify 的标识符（函数名会被改名，找字符串字面量如 `gzipSync`/`__piSessionManagerCache`）；`claim-sessions` 不允许重绑已有主会话（"already owned by another device"），探针实测已归属会话的路径走不通；探针设备用完 revoke（已清理）。

验证：server 821/821（+1 gzip 用例）；fr 已就地部署（`.next.bak-gzip` 为回滚件），健康检查通过。 relay 现状：Mac↔fr 经 901 ~250ms。剩余风险：阿里云 derper 主机早前 ping 2-4s 的转发抖动在 mihomo 绕过后未复现，但当时它还在 TUN 里——若再出现，查那台机器的 CPU/带宽，或把 901 从 derpMap 删掉强制走 903。

### 24.11 DERP 事故与重建（同日深夜）：InsecureForTests ≠ 明文 HTTP

**事故**：24.10 在 tokyo-amd-1/seoul-amd-2 部署的 derper 跑的是明文 HTTP（参照所有者 901 的 `InsecureForTests: true` 配置推演的）。902/903 加入 derpMap 后，几台 linux 机器把 home region 切到延迟最低的自建中继，DERP 连接建立失败，**seoul-amd-2 / tokyo-amd-1 从组网掉线**（seoul-amd-1/dgn-01/fr/tokyo-amd-2 保持 901 在线）。

**根因**（源码实锤 `derp/derphttp/derphttp_client.go`）：tailscale 的 DERP 客户端**永远走 TLS**；`InsecureForTests` 的实际语义是 `InsecureSkipVerify`（跳过证书校验），不是明文。901 的阿里云 derper 一直是 TLS（自签证书）所以正常；我的明文 derper 客户端握手直接失败。

**正确做法**（derper 启动日志会打印推荐配置）：`-hostname <公网IPv4>` + `-certmode manual -certdir /etc/derper-certs` + 带 **IP SAN** 的自签证书（`-addext "subjectAltName=IP:<ip>"`，仅 CN 会被拒）。derper 对 IP hostname 不查 SNI 匹配。derpMap 节点用 `HostName: <IP>` + `CertName: "sha256-raw:<哈希>"`（启动日志直接打印）钉死证书，不再需要 InsecureForTests。

**重建**：tokyo-amd-1/seoul-amd-2 的 tailscaled 卡在坏 region 上无法恢复（无带外凭据，等重启或控制台处理）；改用有凭据的两台重新部署：
- **902 = tokyo-amd-2**（`158.101.85.214`，所有者记录里叫"东京amd1"，tailnet 主机名是 tokyo-amd-2——以 tailnet 名为准）：TLS DERP 握手实测 101 通过，Mac RTT 160ms，可用。
- **903 = seoul-amd-1**（`146.56.173.128:2687`，掉线只是组网问题，机器活着）：derper 已跑、证书就绪，但 **Oracle VCN 安全列表没放 14198/TCP + 22345/UDP**（宿主机 iptables 已开），需所有者在 Oracle 控制台放行。

**注意**：ifconfig.me 在 seoul-amd-1 上返回的是 IPv6 出口地址，做 IP SAN 证书要用 `curl -4`；mihomo 绕过列表（覆写脚本 + mihomo.yaml 双处）已同步换成这两个新 IP；机器间 tailscale ssh 会卡额外认证检查（§13.5），经 fr 跳板执行脚本要 Start-Job/后台 + 结果落盘再轮询。

### 24.12 大会话回填限幅（同日）

所有者确认"第一次打开能看最后一节就行"：超过 2400 条消息的会话不再自动后台回填（`Workspace.tsx` 的 `backfillHistory` 守卫 `BACKFILL_MAX_MESSAGES`），首屏直接看最新窗口，往前翻走手动「加载更早」。lint/tsc/e2e 过。**此改动尚未打包进桌面 App**——下次 `npm run tauri build` 时带上。

### 24.13 第十三轮未关闭事项（增量）

- tokyo-amd-1 / seoul-amd-2 两台 tailscaled 卡死待重启（Oracle 控制台重启即可，其上明文 derper 可弃）；seoul-amd-1 的 VCN 放行 14198/TCP + 22345/UDP。
- derpMap 最终形态（901 保留 + 902 tokyo-amd-2 + 903 seoul-amd-1，均 CertName 钉版）待所有者贴入并复测。

### 24.14 三 region 全部上线（次日晚）

derpMap 三段式（901 阿里云 + 902 tokyo-amd-2 + 903 seoul-amd-1）已贴入生效，902/903 用 `HostName`+`CertName: sha256-raw:...` 钉版（无 InsecureForTests）。

**903 连不通的根因不是 Oracle 安全列表**（VCN 内 hairpin 的 SYN 能到宿主机），而是 **seoul-amd-1 上跑了 wg-quick 全隧道**（wg0 → Cloudflare WARP 162.159.192.1:2408，`ip rule` 把非 fwmark 0xca6c 的出站全部导进 table 51820 = default dev wg0）：外网 SYN 到达 ens3:14198，但 SYN-ACK 被路由进 WARP 隧道，源 IP 错、客户端永远超时。SSH(22/2687) 之所以能连，是因为有人早有 connmark 豁免：mangle PREROUTING `dpt 22/2687 → CONNMARK 0x22` + OUTPUT `spt → MARK 0x22` + `ip rule 100 fwmark 0x22 lookup main`（走 ens3 回包）。

**修复**：给 DERP 加同款豁免并持久化——`/usr/local/sbin/derper-fwmark.sh`（幂等，tcp/14198 + udp/22345 四条 mangle 规则）+ `/etc/systemd/system/derper.service.d/fwmark.conf`（ExecStartPost 调它）。注意：原有 22/2687 豁免**没有**持久化，重启即丢。

**验证**：三个 region `/derp/latency-check` 全 200（Mac→903 修前超时、修后 200）；relay 实测 desktop-fr 经 901（~248ms pong）、seoul-amd-1 经 tokyo-oracle。seoul-amd-2 已自行恢复在线。

**坑**：derper 的 STUN 不响应裸 binding request——`stun.ParseBindingRequest` 要求 SOFTWARE 属性声明来自 Tailscale（v1.102.3 stunserver.go），外置 stunclient/python 手搓包测 STUN 必超时，属设计行为，以 `/derp/latency-check` + relay ping 为准。Mac 上 netcheck 的 seoul-oracle 延迟测不出是 Mac 侧 mihomo/UDP 问题，与服务端无关。

**24.14 续（当夜）——seoul-amd-1  tailnet 失联的根因与修复**：症状是 Mac `tailscale ping 100.83.223.93` 超时、Serve 30141 全不通，但 fr↔seoul-amd-1 直连 IPv6 正常。根因还是 wg0 全隧道：**tailscaled 自己的出站 DERP 连接**（→ 902 的 158.101.85.214:14198）也被路由进 WARP（源地址 172.16.0.2），WARP 每几秒 RST 一次长连接（journal 里 `derp.Recv(derp-902): connection reset by peer`，connGen 15 秒涨 3 次）→ 节点在 home region 上永远掉线。第一版修复用 OUTPUT mangle MARK 0x22 **失败**：源地址在 connect() 时已按 wg0 路由选定（172.16.0.2），mangle 改路由后源地址不变，私网源发包被丢弃。正确修法是**目的地址 ip rule**（connect 前就选对路由表）：`ip rule add to <derper IP> lookup main pref 99`（三台 derper 各一条），连 ssh 之外全部 tailscaled DERP 流量直连 ens3。注意 derper 机器若连**自己**的 region 是 Oracle VCN hairpin（公网 IP 折回私网 10.0.0.104），正常。修完 seoul-amd-1 home 变 seoul-oracle（300µs，本机），`systemctl restart tailscaled` 清掉跨 region 陈旧路由后 Mac↔seoul-amd-1 恢复：ping 经 seoul-oracle ~340ms，`/api/health` 200。全部规则在 `/usr/local/sbin/derper-fwmark.sh`（幂等，含入站回包 connmark + 出站 ip rule 两段），`derper.service.d/fwmark.conf` 持久化。

**24.14 再续——dgn-01 / seoul-amd-2 同款失联**：症状相同（Mac 侧 tailscale ping 通但 TCP/Serve 30141 超时；从 seoul-amd-1 访问两台的 Serve 均 200，证明服务与 Serve 无恙，坏的只是回 Mac 的转发路径——derpMap 三 region 切换期间积累的陈旧跨 region 状态）。解法与 seoul-amd-1 相同：`systemctl restart tailscaled`。无带外凭据，走 seoul-amd-1 跳板 `tailscale ssh root@<目标> "systemctl restart tailscaled"`，会打印 Tailscale SSH 附加检查授权链接（`https://login.tailscale.com/a/...`），所有者在浏览器点一次批准即执行（重启自断连接、Broken pipe 属正常）。重启后四台（fr/dgn-01/seoul-amd-1/seoul-amd-2）`/api/health` 从 Mac 全部 200。经验：**derpMap 变更后把所有在线节点的 tailscaled 重启一遍**，可跳过这类陈旧状态排查。
- fr 的 gzip + 会话缓存修复已就地部署（版本号仍 0.0.3）；三台 linux 与 Windows 安装包下次出 0.0.4 时统一带上（§24.8 缓存 + §24.10 gzip + §22 launcher 修复等）。
- 桌面端未打包的最新一轮：回填限幅 + 首页行式重设计 + edit diff + 借鉴项（§24.1-24.5）。
