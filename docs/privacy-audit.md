# PiHub 隐私审计与发布门禁

本文定义源码公开和 GitHub Release 之前必须执行的隐私检查。它是发布门禁，不代表应用已经满足所有隐私或安全要求。

## 数据边界

PiHub 会处理以下敏感数据：

- 设备名称、主机地址、SSH 用户名和本机配置目录；
- 会话正文、思考内容、工具输入输出、附件、项目路径和 Git 状态；
- Provider/API 配置、认证凭据、服务端日志和安装状态；
- 桌面端本地缓存、系统凭据库、远端 Pi 会话文件与配置文件。

发布前必须确认默认存储位置、文件权限、保留期限、容量上限、删除联动和用户可见开关。凭据不得写入仓库、日志、会话缓存、错误响应或安装包。报告和 CI 日志只输出规则、位置与分类，不能输出命中值。

## 外联边界

正常运行可能涉及用户明确配置的 PiHub 设备、模型 Provider、GitHub 更新源及依赖管理服务。发布前应在干净环境执行动态网络观测，确认：

- 未经用户操作不会连接未披露的第三方服务；
- 更新清单、安装包和签名只从受控的 HTTPS 源读取；
- Provider 请求不会把凭据发送到重定向后的其他来源；
- 错误、遥测、字体、图片和 Markdown 媒体不会绕过外联策略；
- 私有仓库凭据或 GitHub Token 不会被嵌入客户端。

扩展 bundle 构建固定使用隔离的无凭据 npm 环境和 `--ignore-scripts`。物理依赖树只允许精确审计过的 lifecycle 元数据（`tree-sitter-bash@0.25.1`、`onnxruntime-node@1.24.3`、`sharp@0.34.5`）；这些包的已发布资源随包封装，构建阶段不执行脚本、不下载二进制，lock、SRI、host Pi 版本和资源清单仍逐项校验。

静态扫描不能证明依赖没有默认遥测，也不能替代运行时抓包。

## 本地扫描

扫描最终拟提交内容：

```bash
node scripts/privacy-scan.mjs --fail-on-warnings
```

扫描待发布安装包或归档：

```bash
node scripts/privacy-scan.mjs path/to/server.tgz path/to/release.zip
```

机器可读输出：

```bash
node scripts/privacy-scan.mjs --json --fail-on-warnings
```

有 Git 时，默认清单来自 `git ls-files --stage`；无 Git 时，扫描器遍历工作区并跳过 `node_modules`、`.next`、`target`、`dist`、测试报告和其他明确生成目录。显式传入归档时，即使它位于默认排除目录也会扫描。`.tgz`、`.tar.gz` 和 `.zip` 在内存中只读解析，不写入磁盘；成员数、单成员大小、展开体积、累计扫描量和嵌套深度都有上限。无法完整读取、加密或不支持的归档会失败关闭。

命中分类包括：

- 高置信凭据、私钥、GitHub/npm/GitLab/云 Token、JWT 和高熵凭据赋值；
- 真实 `.ts.net` 主机名、CGNAT 主机地址和带用户名的本机绝对路径；
- `.env`、证书、签名材料、内部开发记录、构建产物和发布包；
- 大文件、嵌套 `.git`、gitlink、越界符号链接和不安全归档成员；
- 任何因大小、格式或读取错误而未完成的内容扫描。

测试占位统一使用 `example`、`demo`、`redacted` 或文档保留常量。不要为了通过扫描把整个测试、文档或 lockfile 目录加入 allowlist；确需豁免时应精确到规则和具体占位表达式，并接受人工复核。

扫描器测试：

```bash
node --test scripts/privacy-scan.test.mjs
```

## CI 门禁

`.github/workflows/security.yml` 使用只读默认权限，不使用 `pull_request_target`、仓库秘密或发布权限。门禁包含：

- 自有隐私扫描器与测试；
- Gitleaks 对完整 Git 历史和当前工作树的双重扫描；
- pull request 依赖变更审查；
- 根应用与 Server 两份 lockfile 的高危漏洞审计；
- 根应用与 Server 的 CycloneDX SBOM 生成与官方 CLI 校验；
- JavaScript/TypeScript CodeQL `security-extended` 分析；
- 单独运行 `server/bin/**/*.test.mjs` 安装器测试，避免未来测试 glob 变更造成漏测。

所有第三方 Action 固定到完整提交 SHA。Gitleaks 与 CycloneDX validator 二进制固定版本并校验 SHA-256。CI 生成的 SBOM 只用于门禁，不上传，也不发布任何安装包。

## 首次公开与每次发布

首次初始化 Git 前：

1. 删除嵌套 `.git`，确认 Server 源码将作为普通文件进入根仓库。
2. 运行默认隐私扫描、Gitleaks 工作树扫描、两份 lockfile 审计和 SBOM 校验。
3. 初始化并形成首次提交后，重新扫描 `git ls-files` 和完整 Git 历史。
4. 检查 GitHub 默认工作流权限为只读，禁止 Actions 创建或批准 PR。
5. 启用 dependency graph、Dependabot alerts、secret scanning 和 push protection；将安全 jobs 设为必需检查。

每次发布前：

1. 仅从干净、临时的 CI checkout 构建，不复用开发机的 `.next`、`target` 或历史 tgz。
2. 对每个实际附件显式运行隐私扫描、Gitleaks、二进制字符串检查、恶意软件扫描和格式验签。
3. 生成并验证 SHA-256、签名、SBOM 和 provenance；检查三平台签名身份。
4. 先创建 draft Release。全部附件递归扫描通过且 UI/安装/更新/回滚验证完成后再人工发布。

## 残余风险

扫描器不会尝试破解加密归档，也不会从位图中做 OCR 或推断视觉信息；这类文件会要求人工审查或被阻断。CodeQL 与 dependency review 还取决于目标 GitHub 仓库是否启用了相应产品能力。CodeQL 告警是否阻止合并应在仓库 ruleset 中配置，不能只依赖 workflow 成功状态。
