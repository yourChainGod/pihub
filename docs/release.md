# PiHub Desktop 与 Server 发布配置

正式发布只接受公开仓库 `yourChainGod/pihub` 中已存在的 `refs/tags/vMAJOR.MINOR.PATCH`。自动更新不携带 GitHub Token，因此固定的 Release 源不能使用私有仓库。Tag 必须指向 `main` 可达的提交。工作流会固定 Tag 对象和最终 Commit，并在构建、签名、证明、上传和提升阶段分别向 GitHub 查询；任一阶段发现 Tag 被替换、重建或移动都会失败。

桌面产品使用独立身份 `PiHub Desktop`、bundle identifier `io.github.yourchaingod.pihub.desktop` 和二进制名 `pihub-desktop`，不会覆盖旧的 `PiHub.app`。桌面更新入口为 `pihub-desktop-v1.json` 与 `pihub-desktop-v1.json.sig`，签名清单固定 `channel: desktop-v1-stable` 和 `kind: pihub.desktop-v1-update-manifest`。Server 继续使用 `release-manifest.json` 与 `channel: stable`。

## GitHub 仓库门禁

发布前由仓库管理员完成以下配置：

1. 创建 Tag ruleset，目标模式为 `v*`。限制创建者，禁止更新和删除已有 Tag，并禁止绕过规则。发布开始后不要删除再创建同名 Tag。
2. Actions 默认 `GITHUB_TOKEN` 权限设为只读；只有 draft 上传和稳定版提升 Job 获得 `contents: write`。
3. 创建受保护 Environment `pihub-release-signing`。只允许 `v*` Tag 部署，配置至少一名必要审批人，启用“阻止自我审批”，并禁止管理员绕过保护规则。
4. 创建受保护 Environment `pihub-release-publishing`。同样只允许 `v*` Tag 部署，并由另一名审批人确认签名、隐私扫描和 provenance 后，允许候选资产进入唯一 draft。
5. 创建受保护 Environment `pihub-release-promotion`。只允许 `v*` Tag 部署，至少配置一名未参与构建的必要审批人，启用“阻止自我审批”，并禁止管理员绕过。该 Environment 不保存任何 secret。
6. 不要在 Repository 或 Organization secrets 中保留发布私钥副本。签名材料只放在 `pihub-release-signing` 的 Environment secrets 中。

仅有工作流内校验并不能阻止有写权限的协作者从恶意分支改写工作流；Environment 的 Tag 限制和人工审批是必需的信任边界。

## Environment secrets

`pihub-release-signing` 需要以下 secrets：

| 名称 | 用途 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater 私钥 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri updater 私钥密码 |
| `APPLE_CERTIFICATE` | Base64 编码的 Developer ID Application P12 |
| `APPLE_CERTIFICATE_PASSWORD` | Apple 证书密码 |
| `APPLE_SIGNING_IDENTITY` | 证书中的完整 Developer ID Application identity |
| `APPLE_ID` | Apple 公证账户 |
| `APPLE_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | 10 位 Apple Team ID |
| `WINDOWS_CERTIFICATE` | Base64 编码的 Authenticode PFX |
| `WINDOWS_CERTIFICATE_PASSWORD` | Windows 证书密码 |
| `WINDOWS_CERTIFICATE_THUMBPRINT` | 40 位 SHA-1 证书指纹，不含空格 |
| `PIHUB_SERVER_RELEASE_PRIVATE_KEY` | Server Ed25519 清单签名私钥 |
| `PIHUB_SERVER_RELEASE_PRIVATE_KEY_PASSWORD` | Server 私钥密码；未加密密钥可留空 |

`pihub-release-publishing` 和 `pihub-release-promotion` 都不保存签名私钥。前者只允许写入已签名候选 draft；后者只允许把逐字节复验通过的同一 Release ID 提升为 stable/latest，禁止重签、重传或替换资产。

私钥不得写入仓库、Artifact、缓存或日志。轮换私钥时必须同时发布固定新公钥的客户端版本；不能只替换 CI secret。

## 创建发布

1. 在 `main` 上完成版本、测试和隐私门禁，确认工作树与发布 Commit 一致。
2. 创建 `vMAJOR.MINOR.PATCH` Tag 并推送。不要复用历史版本号。
3. Tag push 会自动启动发布；也可从同一个 Tag 手动重跑：

```bash
gh workflow run release.yml \
  --ref v0.0.1 \
  -f release_ref=refs/tags/v0.0.1
```

手动触发时，`--ref` 选择的工作流版本与 `release_ref` 必须是同一个 Tag。裸 `v0.0.1`、分支、其他 Tag 或预发布格式都会被拒绝。

## 自动验证

- macOS：对 DMG 和其中的 App、updater archive 中的 App 执行 `codesign --deep --strict`，核对 Authority 与 Team ID，并通过 Gatekeeper `spctl` 和 `stapler` 公证票据验证。
- Windows：对安装器和 updater archive 内的可执行文件执行 `signtool verify /pa /all`，再核对 Authenticode 状态、证书指纹和可信时间戳；导入的证书在 Job 结束前移除。
- Linux：分别校验 x86_64/ARM64 AppImage 的 ELF 架构和 deb 的 `amd64`/`arm64` 架构，并检查 updater tar.gz 的格式和内容。Tauri updater 的 Minisign 签名由最终 assembly 对固定公钥逐项验签。
- Server：六个平台归档完成清单、摘要、隐私、异路径启动和鉴权 smoke；最终 Server manifest 在受保护 Environment 中签名。
- provenance：独立 Job 只有 `id-token: write` 与 `attestations: write`，不接触签名私钥或 Release 写权限。
- 资产身份：Tauri 含空格的原始产物只在临时目录存在，Release 中统一为无空格的 `PiHub-Desktop_0.0.1_*`；collector 和 assembly 都使用精确文件名白名单，额外 `.exe`、`.rpm`、签名错配或旧 `PiHub_*` 名称都会失败。

最终 Job 只创建或复用唯一的同 Tag draft。已有 draft 必须仍指向同一 Commit，且已有资产按 Asset ID 下载后必须与本次候选逐字节一致。工作流不会覆盖、删除或静默替换资产。

## 人工发布前检查

Draft 完成后，在真实 macOS、Windows 和 Linux 机器验证安装、首次启动、更新、取消、失败回滚与卸载，并复核 `RELEASE-SHA256SUMS`、GitHub artifact attestations 和平台签名身份。不要在 GitHub UI 手工发布 draft。

审批人下载 draft 中的 `RELEASE-SHA256SUMS`，独立计算其小写 SHA-256，并把精确摘要作为 promotion 输入：

```bash
mkdir -p release-review
gh release download v0.0.1 \
  --pattern RELEASE-SHA256SUMS \
  --dir release-review

checksum_sha256="$(shasum -a 256 release-review/RELEASE-SHA256SUMS | awk '{print $1}')"
gh workflow run promote-release.yml \
  --ref v0.0.1 \
  -f release_ref=refs/tags/v0.0.1 \
  -f release_checksum_sha256="${checksum_sha256}"
```

Promotion 会重新验证 `main` 可达性、同 Commit 的最新 CI/Security workflow run、版本单调递增、完整资产名称/大小/GitHub SHA-256 digest、Tauri 与 Server 签名、人工核对的 checksum 和每项 provenance。写操作只把原 draft Release ID PATCH 为 `draft: false` 与 `make_latest: true`，随后匿名逐字节回读 `pihub-desktop-v1.json`、其签名和 `release-manifest.json`。若发布已成功但回读暂时失败，可用相同 Tag 和 checksum 重跑；流程会进入只读续验，不会再次修改 Release。

本地无真实 Git Tag、Apple 公证账户、Windows 代码签名证书或 GitHub Environment 审批时，只能运行静态契约和 Actionlint，不能宣称真实发布链已经通过。
