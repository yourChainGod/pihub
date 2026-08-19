# Windows 节点

Windows 不提供 Tailscale SSH Server，因此 PiHub 对 Windows 节点使用微软维护的 Windows OpenSSH Server。首次配置完成后，安装部署走桌面机的系统 `ssh`；日常在线终端不再依赖 SSH，而是复用 PiHub Server 的 `node-pty` + Windows ConPTY，由客户端的 xterm.js 渲染。目标节点还必须安装 Node.js `22.19.0` 或更高版本和 npm，Windows 引导流程不会自动安装它们。

## 首次配置

1. 在 Windows 安装并登录 Tailscale，确认设备出现在同一 Tailnet。
2. 在管理员 PowerShell 中运行仓库的 `scripts/windows/Initialize-PiHubOpenSSH.ps1`。
3. 把运行 PiHub 的桌面机 SSH 公钥加入远端用户的 `~/.ssh/authorized_keys`。管理员账户按 Windows OpenSSH 规则使用 `%ProgramData%\ssh\administrators_authorized_keys`。
4. 在 PiHub 的发现页点击“OpenSSH 配置”，输入 Windows 用户名。

脚本使用 Windows Optional Feature、Windows Firewall 和 OpenSSH 服务，不安装自制 SSH 服务。它会：

- 让 `sshd` 只监听本机 Tailscale IP；
- 防火墙只允许 `100.64.0.0/10` 和 `fd7a:115c:a1e0::/48` 来源访问该 Tailscale IP 的 TCP 22；
- 禁用 OpenSSH 安装时可能创建的宽泛入站规则；
- 让 `sshd` 在 Tailscale 服务之后启动。

可先用 `-WhatIf` 查看将使用的 Tailnet 地址。脚本首次修改 `sshd_config` 时会保留 `sshd_config.pihub-backup`。

## 成熟组件边界

- 远程部署：Windows OpenSSH Server / OpenSSH client；
- 远程终端：node-pty 调用 ConPTY，PowerShell 7 优先，Windows PowerShell 回退；
- ANSI 与交互：xterm.js；
- 后台常驻：Windows Task Scheduler，以当前交互用户的有限权限运行；
- 私网入口：Tailscale Serve，PiHub Server 始终只监听 `127.0.0.1:30141`。

PiHub 不保存 SSH 密码，不启用 Tailscale Funnel，也不允许公网或普通局域网地址作为部署目标。
