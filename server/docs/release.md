# PiHub Server GitHub 更新协议

PiHub Server 只从固定公开仓库读取更新，不读取 npm registry、运行时环境变量中的仓库地址、令牌或公钥。

- 仓库：`yourChainGod/pihub`
- 通道：`stable`
- 清单：`https://github.com/yourChainGod/pihub/releases/latest/download/release-manifest.json`
- 信任根：编译进服务端的 Ed25519 公钥，见 `lib/server-release.ts`
- 支持平台：`darwin`、`linux`、`win32`
- 支持架构：`arm64`、`x64`

GitHub `latest` 只作为已发布稳定版本的固定入口；清单内仍必须签名声明 `channel: "stable"`。同一个 `v<version>` Release 同时承载桌面端更新资产、`release-manifest.json` 和不可变的服务端压缩包；服务端资产 URL 中的 tag 必须与清单版本完全相同，可以带 `v` 前缀。草稿和预发布版本不能成为更新源。

## 发布包布局

每个平台和架构必须独立构建。`node-pty` 等原生依赖不能跨平台复用。压缩包使用 gzip tar，内容直接位于归档根目录，不允许再包一层目录。

```text
package.json
.next/
  BUILD_ID
  ...production build
node_modules/
  next/package.json
  next/dist/bin/next
  ...production dependencies
bin/
lib/
next.config.ts
```

最低可运行门槛是：

- `package.json` 的 `name` 必须为 `@pihub/server`，`version` 必须等于签名版本。
- `.next/BUILD_ID`、`node_modules/next/package.json` 和 `node_modules/next/dist/bin/next` 必须是普通文件。
- 归档只能包含普通文件和目录；拒绝符号链接、硬链接、特殊文件、重复路径、大小写冲突、绝对路径、路径穿越和 Windows 保留名称。
- 文件数最多 20,000，单文件最多 1 GiB，展开总量最多 4 GiB，压缩比最多 100:1，签名资产最多 2 GiB。
- 发布包不得包含 `.env`、API Key、签名私钥、GitHub token、用户数据、日志、测试制品或源码映射。

服务端使用当前已安装的 Node.js 运行候选包，因此宿主机仍需满足 `node >= 22.19.0`。

## Release Manifest v1

清单必须是 UTF-8、无 BOM、无重复键的规范 JSON。规范化规则由 `canonicalizeReleaseJson()` 定义：对象键按字典序排列、无空白、只允许安全整数。

```json
{"assets":[{"arch":"x64","platform":"linux","sha256":"<64 lowercase hex>","signature":"<86 char base64url Ed25519 signature>","size":123456,"url":"https://github.com/yourChainGod/pihub/releases/download/v0.0.1/pihub-server-linux-x64.tar.gz","version":"0.0.1"}],"channel":"stable","owner":"yourChainGod","repo":"pihub","schemaVersion":1,"signature":"<86 char base64url Ed25519 signature>","version":"0.0.1"}
```

每个资产先独立签名：

```text
PIHUB-RELEASE-ASSET-V1\n + canonical-json(asset-without-signature)
```

资产签名写回后，再签整个清单：

```text
PIHUB-RELEASE-MANIFEST-V1\n + canonical-json(manifest-without-signature)
```

签名使用 Ed25519，输出为无 padding 的 base64url。私钥只能存放在 GitHub Actions secret 中；仓库、构建日志、缓存和 artifact 均不得包含私钥。公钥轮换必须通过发布新的受信任应用版本完成，不能由远程清单覆盖。

## 更新事务

稳定 supervisor 不随 Next.js 子进程退出。一次更新按以下顺序执行：

1. 获取并验证固定 GitHub 清单，拒绝凭据和非固定仓库重定向。
2. 获取当前平台资产，边下载边校验签名大小和 SHA-256，写入私有 staging。
3. 使用 `tar` 库先检查再解压，并对实际文件树做第二次审计。
4. 原子发布候选版本，在独立 loopback 端口启动，并精确校验 `/api/health.version`。
5. 原子切换 `current.json`，停止旧子进程，在正式端口启动新版本并再次精确健康检查。
6. 成功后记录 known-good 并清理旧版本；失败则恢复旧指针、重启旧版本并清理候选。
7. supervisor 或机器异常退出后，根据持久化 journal 完成提交或回滚。

更新目录按平台存放：

- macOS：`~/Library/Application Support/PiHub/Server`
- Linux：`$XDG_DATA_HOME/pihub/server`，未设置时使用 `~/.local/share/pihub/server`
- Windows：`%LOCALAPPDATA%\PiHub\Server`

同一时刻只允许一个更新事务。状态目录和 staging 使用用户私有权限；日志使用 5 MiB 上限和一个轮转备份。

## HTTP API 契约

两个接口都要求受信任设备身份和 `system:update` capability，所有响应均为 `Cache-Control: private, no-store`。

### `GET /api/pihub/updates`

成功为 `200`：

```json
{
  "server": {
    "current": "0.0.1",
    "latest": "0.0.2",
    "updateAvailable": true,
    "platform": "linux",
    "arch": "x64",
    "channel": "stable"
  },
  "installSupported": true,
  "update": {
    "phase": "idle",
    "updatedAt": "2026-08-19T12:00:00.000Z"
  },
  "running": [],
  "checkedAt": "2026-08-19T12:00:01.000Z"
}
```

`current` 在没有可确认版本时可以为 `null`；`update` 在未安装稳定 supervisor 时为 `null`。`running` 是仍在运行的 Agent session id 列表。

`update.phase` 的严格联合类型：

- `idle | recovering`：`phase`, `updatedAt`
- `queued | applying`：另含 `operationId`
- `restarting`：另含 `targetVersion`，更新事务内还含 `operationId`
- `succeeded`：另含 `operationId`, `resultVersion`
- `failed`：另含 `operationId`, `errorCode`

### `POST /api/pihub/updates`

请求只接受：

```json
{"action":"apply","force":false}
```

`force` 可省略。存在运行中的 Agent session 时，默认返回 `409 busy`；只有用户明确确认后才能发送 `force: true`，这会允许服务重启并中断这些 session。

成功排队立即返回 `202`，不等待下载、重启或回滚完成：

```json
{
  "accepted": true,
  "operationId": "<32 lowercase hex>",
  "update": {
    "phase": "queued",
    "operationId": "<same id>",
    "updatedAt": "2026-08-19T12:00:00.000Z"
  }
}
```

客户端收到 `202` 后轮询 GET，直到相同 `operationId` 进入 `succeeded` 或 `failed`。不要根据 HTTP 连接中断推断更新失败，也不要在 `queued`、`applying` 或 `restarting` 阶段重复提交。

主要错误状态：

- `401`：未认证。
- `403`：缺少 `system:update` capability。
- `400`：请求体、action 或字段非法。
- `409 busy`：仍有 Agent session；需要明确的强制更新确认。
- `409 concurrent_update`：已有更新事务。
- `502 release_unavailable`：GitHub 清单、签名、平台资产或 release 不可验证。
- `503 unsupported_platform`：平台或架构不支持。
- `503 update_runtime_unavailable | update_runtime_timeout | update_runtime_invalid`：稳定 supervisor 不可用。

UI 不应显示内部错误文本，只根据 `errorCode` 提供可操作状态并允许查看私有本机日志。

## 发布门禁

发布工作流必须在上传资产前完成：

```bash
npm ci --prefix server
npm run build --prefix server
npm test --prefix server
npm exec --prefix server -- tsc --noEmit
```

还必须执行三平台 bundle 冒烟测试、秘密扫描、归档清单检查、签名后本地验签，以及候选启动、精确版本健康检查、失败回滚测试。只有桌面端与服务端资产全部通过后，才能发布同一个 `v<version>` Release 并让 GitHub `latest` 指向它；发布失败时，上一版已发布 Release 仍必须保持可用。
