# 第三方声明

PiHub 包含并修改了以下 MIT 许可项目的代码。各项目的完整许可文本见 `THIRD_PARTY_LICENSES.md`；Pi Web 的原始许可也保留在 `server/LICENSE`。

## Pi Web

- 项目：https://github.com/agegr/pi-web
- 原作者：agegr
- 版权：Copyright (c) 2026 agegr
- 许可：MIT

PiHub Server 基于 Pi Web 改造，保留其会话、智能体和文件处理基础，并增加桌面端协议、远端设备管理与安全边界。

## pi-provider-newapi

- 项目：https://github.com/ttimasdf/pi-provider-newapi
- 原作者：Known Rabbit / ttimasdf
- 版权：Copyright (c) 2026 Known Rabbit
- 许可：MIT

PiHub 只发布 Server 内置的单一 NewAPI Provider 实现；历史本地 fork 不进入源码仓库、安装包或 Release。

## 依赖

其他运行时和构建依赖仍受各自许可证约束。发布资产会附带由锁文件生成的第三方许可证清单与 SBOM；该清单不改变任何依赖的原始许可。
