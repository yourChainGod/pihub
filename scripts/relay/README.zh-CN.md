# PiHub Relay（tokyo-arm）

两个容器：Caddy 终结 WSS（Cloudflare origin 证书）→ NATS Core（无 JetStream、无持久化）。
Caddy 同时负责规整 WebSocket Upgrade 头——CF 代理后的请求头格式会被 NATS 严格校验拒绝。
入口：`wss://relay.ffuu.eu.org`（CF 橙云 → tokyo-arm:443）。
注意：CF 后台必须开启 Network → WebSockets，且 SSL/TLS 为 Full (Strict)。

## 主机目录 `/root/pihub-relay/`

```
docker-compose.yml   nats-server.conf   relay-provision.mjs
accounts.conf        # 由 provision 渲染，勿手改
accounts.json        # provision 的事实来源（含 token，0600）
certs/origin.pem     # CF origin 证书链
certs/origin.key     # CF origin 私钥
```

## 部署 / 更新

```bash
# 首次：装 docker + docker-compose-v2，放行 443（主机 iptables 与 OCI 安全列表）
cd /root/pihub-relay && docker compose up -d
```

## 账号管理（主机上执行，无需本地 node）

```bash
cd /root/pihub-relay
alias provision='docker run --rm -v "$PWD:/relay" -w /relay node:22-alpine node relay-provision.mjs'
provision add-desktop                 # 桌面端共享传输 token（真实鉴权靠端到端 HMAC）
provision add-node dgn-01             # 输出该节点的 connector 配置 JSON
provision connector-config dgn-01     # 重印节点配置
provision remove-node dgn-01
provision list
```

provision 会原子重写 accounts.conf 并 `docker kill -s HUP pihub-relay-nats` 热加载。

## Subject 布局

- `node.<id>.request` — request/reply，桌面 → 节点 connector
- `node.<id>.stream.open|close` — SSE 流开关
- `node.<id>.events.<streamId>` — 节点 → 桌面的事件帧
- `node.<id>.xfer.<xferId>` — 双向分块大流量（文件、历史）
- `node.<id>.term.<tid>.in` — 终端输入有序二进制帧

ACL：节点账号只能订自己的 `node.<id>.>`、发自己的 events/xfer 与 `_INBOX.>`；
桌面账号可发 `node.>`、订 `_INBOX.>` 与 `node.*.events.>` / `node.*.xfer.>`。
NATS 层只是传输隔离；真正的授权是端到端 HMAC 签名（未配对设备拿不到节点 secret）。

## 运维

- 日志：`docker logs pihub-relay-nats --tail 200` / `docker logs pihub-relay-caddy --tail 200`
- 热加载账号：`docker kill -s HUP pihub-relay-nats`
- 换证书：替换 certs/ 后 `docker compose restart`（origin 证书 15 年有效，几乎不用管）
- 备份：`accounts.json` 与 `certs/` 即可，无其他状态
