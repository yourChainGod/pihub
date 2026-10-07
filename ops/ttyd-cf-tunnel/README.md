# ttyd + Cloudflare Tunnel

把本机终端通过 **ttyd** 暴露到浏览器，再用 **Cloudflare Named Tunnel** 打通公网，
无需开放任何入站端口。

```text
Browser ──HTTPS/WSS──> Cloudflare edge ──tunnel(QUIC)──> cloudflared ──> 127.0.0.1:7681 (ttyd)
```

## 本次部署的实际状态

| 项目 | 值 |
| --- | --- |
| ttyd | `~/.local/bin/ttyd`（静态二进制，v1.7.7） |
| cloudflared | `~/.local/bin/cloudflared`（静态二进制，2026.10.0） |
| ttyd 监听 | `127.0.0.1:7681`（仅回环，Basic Auth 必填） |
| tunnel id | `0b05c8df-3977-4134-b8e6-ba0e1ffec5ed` |
| 公网入口 | `https://aag.cc.cd`（云端 ingress 指向 `http://127.0.0.1:7681`） |
| 日志 | `/tmp/ttyd.log`、`/tmp/cloudflared.log` |

沙箱里没有 `sudo`，所以两个二进制都是用户态静态安装，未改动系统包管理器。

## 凭据（不进 git）

| 文件 | 权限 | 内容 |
| --- | --- | --- |
| `~/.cloudflared/tunnel-token` | `600` | CF Zero Trust 里生成的隧道 token |
| `~/.cloudflared/ttyd-cred` | `600` | 第一行用户名、第二行密码 |

`start-tunnel.sh` 通过 `TUNNEL_TOKEN` 环境变量传递 token，避免出现在 `ps` 输出里。

## 一条命令恢复（沙箱被回收后）

这个沙箱是**临时**的：`~/.local/bin`、`~/.cloudflared`、`/tmp` 都不会保留。
容器重建后两个进程全丢，公网表现为 **Cloudflare 530 / 错误 1033**（隧道无连接），
本地表现为 `curl: (7)`。恢复只需：

```bash
TUNNEL_TOKEN='<你的隧道 token>' ops/ttyd-cf-tunnel/bootstrap.sh
```

脚本幂等：只补缺失的二进制/凭据，再重启两个进程并自检。
省略 `TUNNEL_TOKEN` 时复用已有的 `~/.cloudflared/tunnel-token`。


## 启动 / 停止

```bash
ops/ttyd-cf-tunnel/start-ttyd.sh      # 起 ttyd（回环 + Basic Auth）
ops/ttyd-cf-tunnel/start-tunnel.sh    # 起 cloudflared

pkill -f 'cloudflared.*tunnel' ; pkill -f '/ttyd '   # 停止
```

可用环境变量覆盖：`TTYD_PORT`、`TTYD_CRED_FILE`、`TTYD_LOG`、`CF_TOKEN_FILE`、`CF_LOG`。

## 验收命令

```bash
# 本地：无凭据应 401，带凭据应 200
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7681/
curl -u "$(head -1 ~/.cloudflared/ttyd-cred):$(sed -n 2p ~/.cloudflared/ttyd-cred)" \
     -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7681/

# 公网
curl -o /dev/null -w '%{http_code}\n' https://aag.cc.cd/

# 隧道注册状态
grep -c 'Registered tunnel connection' /tmp/cloudflared.log   # 期望 4
```

WebSocket 必须用 `--http1.1` 测，否则 curl 在 HTTP/2 下会丢掉 `Upgrade` 头，
得到的是假 404：

```bash
curl --http1.1 -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -u "$(head -1 ~/.cloudflared/ttyd-cred):$(sed -n 2p ~/.cloudflared/ttyd-cred)" \
  https://aag.cc.cd/ws        # 期望 101
```

## 换域名 / 加路径

隧道是**远端管理**的，ingress 在 Cloudflare 控制台改：
Zero Trust → Networks → Tunnels → 选中该隧道 → Public Hostname。
本地不需要改任何文件，cloudflared 会自动收到新配置（日志里
`Updated to new configuration ... version=N`）。

## 安全提醒

- 这条隧道把**一个可写 shell** 放到公网。ttyd 的 Basic Auth 是唯一的门槛，
  且没有速率限制/锁定策略，请至少：
  - 在 Zero Trust 里给 `aag.cc.cd` 挂一条 **Access 策略**（邮箱/OTP 或 service token），
    这样 Basic Auth 之前还要过一层身份校验；
  - 不要用弱密码；`~/.cloudflared/ttyd-cred` 保持 `600`。
- 若要临时关闭对外入口，直接 `pkill -f cloudflared`，ttyd 仍可在本地使用。
- 沙箱随时可能被回收，`/tmp` 与 `~/.local/bin` 不会保留；
  重建后按本文档重跑两个脚本即可。
