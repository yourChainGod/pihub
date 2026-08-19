# 安全策略

## 支持范围

PiHub 尚处于 `0.0.x` 初始开发阶段。安全修复只保证进入最新发布版本；旧的预发布版本可能不再单独维护。

## 报告漏洞

请不要在公开 Issue、讨论区、日志或截图中披露漏洞细节、设备地址、会话内容、访问凭据或复现数据。

请通过仓库的 **Security > Report a vulnerability** 私密提交报告，并包含：

- 受影响版本与操作系统；
- 最小复现步骤和预期影响；
- 已确认的数据、权限或设备边界；
- 可安全共享的日志，且已删除凭据、主机名、IP、用户名和绝对路径。

维护者确认收到报告后，会先复现和评估影响，再协调修复与披露时间。未经协调，请勿在修复可用前公开利用细节。

## 默认安全边界

- PiHub Server 只监听回环地址，远端访问应通过 Tailscale Serve 的 HTTPS 入口。
- 除最小健康检查与配对入口外，API 默认要求已配对设备认证。
- 凭据不得写入仓库、Issue、CI 日志、Release 附件或诊断导出。
- 安装包和更新必须验证发布签名与 SHA-256；验证失败时不得继续安装。
- 远程插件/Skill 安装、更新和删除在签名不可变目录落地前必须失败关闭；完整不变量见 [ADR 0002](server/docs/adr/0002-require-signed-immutable-package-catalog.md)。

## 本地文件系统威胁模型

已授权工作区内的文件、Git 和 worktree 操作会检查规范路径、符号链接或 junction、文件类型、Git 注册关系和对象身份；写入通过私有临时文件与原子发布完成。Git 子进程不会经过 shell，并关闭 hooks、`fsmonitor`、textconv 等仓库控制的执行入口。

这些措施不能把与 Server 以同一操作系统用户运行的恶意本地进程视为完全隔离的攻击者。纯 Node.js 缺少跨平台的 handle-relative 路径 API（例如完整的 `openat`/`renameat2` 或 Windows 等价能力），因此在最终 pathname syscall 前替换祖先目录的竞争窗口只能缓解，不能证明彻底消除。类似地，mount/FUSE 在保持相同规范路径时重绑定文件树，以及跨重启持久验证原生 file id，目前也不视为已关闭风险。

发布版不得把上述两类风险标记为“已修复”。文件系统或授权根实现发生变化时，必须重新执行 Linux、macOS、Windows 原生 runner 测试，覆盖 symlink/junction、ADS 与保留名、大小写和 Unicode 别名、rename replacement、Git executable 隔离及服务生命周期。任一目标平台缺少真实验证或出现失败，都属于发布阻断。

若发现发布资产签名异常、仓库密钥泄露或供应链污染，请停止安装和更新，并立即按上述私密渠道报告。
