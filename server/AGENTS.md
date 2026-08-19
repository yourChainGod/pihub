# PiHub Server 维护说明

`server/` 是 PiHub 桌面端使用的 headless 设备服务，不是独立的浏览器/PWA 产品。根页面只提供运行状态，产品 UI 位于仓库根目录的 Tauri/React 应用。不要重新引入旧 Pi Web 的 `components/`、`hooks/`、PWA、远程截图、浏览器持久缓存或 npm 自更新流程。

## 常用命令

```bash
npm ci
npm run dev:headless
npm test
npm exec -- tsc --noEmit
npm run lint
npm run build
```

Node.js 最低版本为 `22.19.0`。发布包包含平台原生依赖，必须在对应平台和架构上构建，不能复制其他 runner 的 `node_modules`。

## 请求链路

```text
Tailscale Serve HTTPS
  -> loopback Next.js server
  -> proxy.ts: Host/Origin + device authentication + capability
  -> app/api route
  -> lib service boundary
  -> Pi SDK / filesystem / Git / PTY / update supervisor
```

`proxy.ts` 是统一 API 鉴权入口。它验证成功后删除外部传入的内部身份 header，再写入受信任的 device/capability/digest header。Route 只能通过 `getTrustedPihubRequestContext()` 或相应 session/file helper 读取该上下文，不能直接信任请求参数或原始 header 中的 device id。

公共 API 只允许：

- `GET /api/health`
- `POST /api/pairing/claim`

新增或修改 API 时必须同时更新 `lib/pihub-auth.ts` 的显式 policy，并添加无凭据 `401`、错误 capability `403` 和合法 capability 的测试。未知方法或路径必须失败关闭。

## 安全不变量

### 设备鉴权

- 签名上下文固定为 `pihub-request-v3`；方法、规范 target、timestamp、nonce、epoch 和 raw-wire body SHA-256 都在签名内。
- nonce 在验证后登记并限制容量；不要在 route 中重复消费或绕过防重放。
- multipart 的代理鉴权不克隆大 body，route 必须继续使用 `streaming-multipart-upload.ts` 校验同一个 raw-wire digest 与硬限额。
- 一次性配对码只存 digest；设备 secret 只在 claim/rotate 的明确 secret 输出中出现。
- 管理 CLI 的 secret 不得进入 argv、env、默认 stdout 或日志。

### 会话与运行时

- 每个新会话必须绑定已认证 owner；读取、运行、改名、导出和删除都必须验证 owner。
- legacy 未归属会话只能通过本机 `pihub-auth-admin claim-sessions` 显式认领，不能被任意远程设备自动接管。
- Agent session、SSE replay、running 状态和 allowed roots 都按 device scope 隔离。
- 生产 Agent/模型构造必须经过 `lib/safe-model-runtime.ts`。不要恢复 `models.json` 中的 `!command`、`$ENV`、`${ENV}` 或动态 header 执行。
- 项目级扩展可执行代码，任何加载或包操作都必须保留项目信任检查。

### 文件、Git 与终端

- 先在 `allowed-roots.ts` 建立 owner 作用域，再通过 `path-security.ts`/`file-access.ts` 解析路径。
- 禁止用词法前缀替代规范路径、realpath、symlink/reparse-point 和 TOCTOU 检查。
- 上传必须流式、有界、写入私有临时文件并原子发布；错误路径必须清理。
- Git 参数以数组传给 `spawn`/`execFile`，禁止 `shell: true`。worktree 删除、hook 和 checkout 路径必须继续执行安全校验。
- PTY 通过 `pihub-terminal.ts` 管理；保持每 owner、每进程和订阅者上限，并在断开/停止时回收进程。

### 网络与凭据

- Server 只监听 `127.0.0.1`；不要增加 `0.0.0.0`、LAN、公网或 Funnel 入口。
- Provider 和目录发现的外联必须经过 `outbound-http-security.ts` 的 scheme、地址、重定向和 credential policy。
- 跨 origin 重定向不能携带 Authorization、API key、cookie 或 GitHub token。
- 日志、错误响应、导出、测试快照和 Release 资产不得包含 secret、配对码、真实 `.ts.net` 主机、CGNAT IP、用户名或本机绝对路径。

### 更新与服务

- GitHub owner、repo、channel 和 Ed25519 公钥是编译期信任根，不能由请求、环境变量或远程清单覆盖。
- 清单来自固定仓库的 latest Release，channel 必须为 `stable`；Server 资产必须使用不可变的 `v<version>` URL。
- 保留资产签名、SHA-256、大小、tar 条目、展开大小、路径与平台/架构校验。
- 更新必须由稳定 supervisor 执行候选健康检查、原子 current 指针、journal 恢复和失败回滚；Next.js 子进程不能直接替换自己。
- `pihub-server-service` 必须维持当前用户权限、定义漂移检查、精确版本 health、安装回滚，以及 `uninstall` 保留数据的契约。

## 文件地图

```text
app/api/                         headless routes and route-level tests
app/page.tsx                     minimal status page
proxy.ts                         Host/Origin and API authentication boundary
instrumentation.ts               Pi runtime startup integration

bin/pi-web.js                    stable supervisor entry point; filename retained for compatibility
bin/server-supervisor.js         child lifecycle, IPC and update orchestration
bin/pihub-server-install.js      service install/status/repair/logs/uninstall
bin/pihub-server-install-windows.ps1
                                  current-user Task Scheduler implementation
bin/pihub-auth-admin.js          local device/session ownership administration
bin/bounded-log.js               private bounded logs and redaction

lib/pihub-auth.ts                request signing, replay and API policy
lib/pihub-auth-store.ts          durable device and pairing state
lib/session-ownership.ts         durable per-device session owner map
lib/session-access.ts            trusted session authorization helpers
lib/allowed-roots.ts             per-device workspace grants
lib/path-security.ts             canonical containment primitives
lib/file-access.ts               file authorization boundary
lib/streaming-multipart-upload.ts
                                  bounded raw-wire uploads
lib/worktree.ts                  Git worktree operations
lib/git-command.ts               bounded shell-free Git execution
lib/pihub-terminal.ts            PTY/ConPTY lifecycle and quotas
lib/safe-model-runtime.ts        final production model/credential boundary
lib/outbound-http-security.ts    SSRF, redirect and credential forwarding policy
lib/release-manifest.ts          canonical signed manifest validation
lib/server-release.ts            fixed GitHub Server update trust
lib/server-update-runtime.ts     platform storage and transactional updater
lib/update-engine.ts             platform-neutral update transaction

docs/release.md                  signed GitHub update protocol
docs/worktrees.zh-CN.md          current desktop worktree behavior
docs/adr/                        retained architecture decisions
```

## 改动检查

按风险选择测试，不要只依赖 TypeScript 编译：

- API 或鉴权：相关 route tests、`pihub-auth.test.mjs`、`request-security.test.mjs`、scoped route matrix。
- 文件或 Git：安全 route tests、path/file/worktree/git tests，包含符号链接、Windows 路径和失败清理。
- Agent/session：rpc manager、session ownership/access、SSE reconnect/replay 和 shutdown tests。
- Provider/模型：safe model runtime、provider credential、model discovery 和 outbound HTTP tests。
- 服务/更新：`bin/**/*.test.mjs`、release manifest、update engine/runtime/IPC tests。
- 发布前：完整 `npm test`、`tsc --noEmit`、ESLint、production build、根目录隐私扫描和目标平台原生 bundle 冒烟。

测试临时目录必须放在系统 temp 中并在结束时清理。不要使用真实凭据、真实主机名或开发者绝对路径作为 fixture。

## 文档与兼容

- 用户文档以仓库根 [`../README.md`](../README.md) 和本目录 [`README.md`](README.md) 为准。
- `bin/pi-web.js` 入口文件名、部分 `PI_WEB_*` 内部兼容变量和上游源码文件名暂时保留，不表示重新提供 Pi Web 浏览器产品；公开 CLI 不提供 `pi-web` 别名。
- 新的用户可见命令必须先有实现和测试，再写入文档。
- 跨平台路径、进程、服务和终端逻辑要在 macOS、Windows、Linux 的原生 runner 验证；在一个平台上的 mock 不能代替安装测试。
