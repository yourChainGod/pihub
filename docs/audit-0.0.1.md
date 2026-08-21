# PiHub 0.0.1 发布审计清单

更新时间：2026-08-19

本文是 PiHub `0.0.1` 的可追踪发布清单。它记录当前源码快照已有的证据和仍缺少的证据，不以“未发现问题”替代完成证明。只有所有阻断项关闭、最终 Git 提交和发布资产重新验证后，才可以把版本标记为可公开发布。

状态含义：

- `PASS`：当前源码或工件已有直接、可重复的验证证据。
- `PARTIAL`：实现或局部验证已存在，但尚不能覆盖完成标准的全部平台或链路。
- `BLOCKED`：缺少发布所要求的外部状态、原生平台证据、签名材料或最终工件。

## 完成标准矩阵

| 编号 | 范围 | 当前状态 | 直接证据 | 仍需关闭 |
| --- | --- | --- | --- | --- |
| 1 | 全代码与架构审计 | `PARTIAL` | `server/docs/adr/0001-*`、`server/docs/adr/0002-*`、本清单；Server 全量测试覆盖 API、鉴权、文件、Git、PTY、Provider、安装与更新 | 在最终提交上重新执行全仓静态扫描，并把 clean release、Tauri 和 GitHub 结果回填 |
| 2 | 功能完整性与回收 | `PARTIAL` | Server 全量测试；桌面 E2E 覆盖主要 loading、empty、error、retry、confirm、offline 和更新状态；请求级网络与子进程取消有定向测试 | 用最终构建重复全套 Playwright；三平台验证 PTY、服务中断、更新失败与回滚 |
| 3 | UX/UI 与无障碍 | `PARTIAL` | 三浏览器资源管理专项 `27/27`；720x620、键盘、Axe、减少动态效果和强制高对比测试 | 最终提交上执行全部三浏览器用例和视觉基线，不接受 skip 或 flaky |
| 4 | 品牌图标 | `PARTIAL` | `scripts/verify-icon-assets.mjs` 与脚本测试验证 π 源图和平台资产生成 | 在最终 macOS、Windows、Linux 安装产物及 Dock/任务栏/启动器中人工核验全部尺寸 |
| 5 | 跨平台 Server | `BLOCKED` | 安装器、service lifecycle、路径、Windows PowerShell、systemd 和 launchd 单元测试 | 必须在 macOS/Windows/Linux 的 arm64/x64 原生 runner 完成安装、升级、状态、修复、日志、卸载、回滚和开机自启验证 |
| 6 | 安全与隐私 | `PARTIAL` | Server 鉴权、nonce、设备隔离、文件/Git/PTY、SSRF、凭据最小环境、插件 opaque handle 和更新验签测试；filesystem 隐私扫描 `0/0`；两份生产依赖 audit 为 `0 vulnerabilities` | 在最终 Git 历史和所有附件上执行 privacy、Gitleaks、SBOM、provenance、CodeQL 与平台原生文件系统验证；`SECURITY.md` 所列 TOCTOU/mount 风险仍是发布门禁 |
| 7 | 测试与质量门 | `PARTIAL` | 根与 Server lint/typecheck/build 局部门禁通过；Server 全量 `801/801`；发布脚本 `89/89`、零 skip；根 unit `3/3` | clean Server production build、全套 Playwright、Rust fmt/clippy/test、六平台 release smoke 必须在最终提交重新执行 |
| 8 | 版本、文档与发布 | `PARTIAL` | `scripts/check-release-config.mjs` 确认 Desktop/Server 均为 `0.0.1`；中文 `README.md`、`SECURITY.md`、隐私和发布文档存在 | 对最终安装包、内嵌 Server、SBOM、manifest、NOTICE 和第三方许可再次核验版本与内容 |
| 9 | GitHub 交付 | `BLOCKED` | 当前 tracked tree 隐私扫描：495 个文件，`0 error / 0 warning` | 当前工作区尚无最终 Git 历史；目标仓库、main 保护、安全功能、不可变 `v0.0.1` tag 和 Release 尚未形成或尚无可验证证据 |
| 10 | GitHub 更新闭环 | `BLOCKED` | Desktop 和 Server 的固定仓库、固定公钥、签名 manifest、hash、平台/架构、原子切换和回滚逻辑有单元测试 | 必须用最终 GitHub Release 资产完成 Desktop 与 Server 的真实检查、下载、验签、候选健康检查、切换、重启恢复和回滚演练 |

## 安全不变量

发布候选必须同时满足以下条件：

1. 只有 `GET /api/health` 和 `POST /api/pairing/claim` 可以匿名访问，其他 API 由代理与路由能力检查共同失败关闭。
2. 设备签名绑定 method、target、timestamp、nonce、epoch 和 raw body digest；跨设备 owner 资源返回与不存在资源一致的拒绝结果。
3. 工作区、文件、Git、PTY、Provider、Plugin 和 Skill 的读取与变更能力分离；项目可执行资源必须先经过 trust gate。
4. 动态 Skill/Plugin 安装、更新和删除在签名不可变目录实现前固定返回 `signed_catalog_required`；插件启停只接受 scope-bound opaque handle。
5. 外联只能经过固定来源或共享 secure outbound transport；禁止 caller-selected redirect、私网地址、DNS rebinding、无界响应和凭据跨源转发。
6. 请求取消必须传递到网络请求、子进程、PTY、SSE、上传和临时文件；超时或失败不得留下可见的半成品。
7. release npm、Next build、扩展 loader、Server runtime 和服务安装器使用最小环境，凭据不得进入 argv、日志、错误、导出、快照、SBOM 或附件。
8. 所有发布 manifest、asset、checksum、SBOM 和 provenance 必须绑定同一不可变 tag commit；签名或任一绑定校验失败即停止发布。

## 当前可重复门禁

以下命令应在干净 checkout 中执行。测试数量可能随着新增用例变化，最终以退出码、零失败和零 skip 要求为准。

```bash
npm ci
npm run lint
npm exec -- tsc --noEmit --pretty false
npm run test:unit
npm run build
npm exec -- playwright test

npm --prefix server ci
npm --prefix server run lint
npm --prefix server exec -- tsc --noEmit --pretty false
npm --prefix server test
npm --prefix server run build

node --test scripts/*.test.mjs
node scripts/check-release-config.mjs
node scripts/privacy-scan.mjs --fail-on-warnings
npm audit --omit=dev --audit-level=high
npm --prefix server audit --omit=dev --audit-level=high

cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features
```

## GitHub 与发布顺序

1. 等待所有并行修改停止，在当前文件系统快照执行严格隐私和 secret 扫描。
2. 初始化干净 Git 历史，确认 tracked tree 不含依赖、构建输出、测试媒体、真实设备信息、本机路径、凭据或签名私钥。
3. 对 tracked tree 和完整历史重复 privacy 与 Gitleaks 扫描；任何 warning 都阻止推送。
4. 创建固定仓库，推送 `main`，启用 branch ruleset、只读默认 Actions 权限、Dependabot、CodeQL、secret scanning 和 push protection。
5. 只从受保护 `main` 的一个不可变 commit 创建 `v0.0.1` tag；CI 在各原生 runner 构建，不复用开发机工件。
6. 对每个平台附件执行格式、签名、hash、隐私、SBOM、provenance、安装和更新验证，然后才能把 draft Release 提升为公开 Release。

## 当前发布结论

`0.0.1` 目前不是可公开发布状态。代码级和本地门禁已有较强覆盖，但三平台原生证据、最终 clean release 资产、Git 历史与仓库安全状态、正式签名和 GitHub 更新演练仍未完成。不得用本地单元测试或模拟资产替代这些证据。
