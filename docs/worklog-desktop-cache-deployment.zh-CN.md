# PiHub 桌面端缓存机制部署交接文档

> 编写时间：2026-08-22 00:07  
> 当前状态：桌面端已部署，服务端待审计

---

## 一、任务背景

**目标**：优化桌面端缓存机制，提升会话加载性能

**改动范围**：
- 前端：16 个文件（缓存层 + UI 交互）
- 服务端：49 个文件（与缓存无关，疑似历史未提交改动）

---

## 二、已完成工作

### 2.1 桌面端打包与部署

#### 打包过程
```bash
# 编译前端
npm run build  # tsc + vite build

# 编译 Tauri 桌面端
npm run tauri build
# 产物：src-tauri/target/release/bundle/dmg/PiHub Desktop_0.0.1_aarch64.dmg
```

#### 部署结果
- ✅ 旧版备份：`/Applications/PiHub Desktop.app.backup-20260822-000317`
- ✅ 新版安装：`/Applications/PiHub Desktop.app`（2026-08-22 00:03）
- ✅ 编译耗时：29 秒（Rust release profile）

#### 前端改动清单
```
src-tauri/Cargo.lock                          # Rust 依赖锁定
src-tauri/Cargo.toml                          # 新增 serde_json 依赖
src-tauri/src/lib.rs                          # 新增 resource_cache 命令
src-tauri/src/bootstrap_unix.sh               # 引导脚本
src-tauri/src/bootstrap_windows.ps1           # Windows 引导脚本
src-tauri/src/standalone_bootstrap.mjs        # 独立引导逻辑
src-tauri/tauri.conf.json                     # Tauri 配置
src/App.tsx                                   # 应用入口
src/ChatMinimap.tsx                           # 小地图组件
src/DeviceSetup.tsx                           # 设备设置
src/MessageView.tsx                           # 消息视图（增量加载优化）
src/RemoteTerminal.tsx                        # 远程终端
src/Workspace.tsx                             # 工作区（缓存集成）
src/lib.ts                                    # 远程 API 封装
src/sessionCache.ts                           # 会话缓存层（核心）
src/styles.css                                # 样式调整
src/types.ts                                  # 类型定义
```

---

## 三、待处理问题

### 3.1 服务端部署状态

**症状**：桌面端报错 "Agent request failed"

**原因分析**：
1. ✅ **Tauri 命令协议独立** — `resource_cache` 系列命令仅在本地使用，不依赖服务端
2. ✅ **前端无新增 API** — 缓存层包装的是既有 API（`/api/sessions`, `/api/agent`）
3. ⚠️ **服务端 49 个文件改动未部署** — 可能包含协议破坏性变更

**服务端改动文件**（部分）：
```
server/app/api/agent/[id]/route.ts            # Agent API
server/app/api/agent/new/route.ts             # 新建 Agent
server/app/api/sessions/[id]/route.ts         # 会话详情 API
server/app/api/sessions/route.ts              # 会话列表 API
server/app/api/pihub/setup/route.ts           # 设备设置 API
server/bin/pi-web.js                          # Web 服务入口
server/bin/pihub-server-install.js            # 服务端安装脚本
... （共 49 个文件）
```

---

### 3.2 服务端构建受阻原因

#### 问题一：Node 版本不匹配
- **本地环境**：Node v23.5.0
- **构建要求**：Node 22.19.x（`scripts/build-server-release.mjs` 检查）
- **Homebrew node@22**：损坏（symlink 指向 v23）

#### 问题二：远程 SSH 失败
- **dgn-01**：`ssh root@dgn-01` 连接被拒
- **tailscale ssh**：连接成功但 node 不在 PATH（`/root/.local/share/pi-node/bin/node` 不存在）

#### 问题三：跨平台编译不可行
- **原生模块依赖**：服务端使用 `node-pty`（终端模拟），必须在目标平台构建
- **目标设备**：
  - dgn-01: Linux x64
  - ecs-01: Linux x64
  - wsl-pc-01: WSL2 Linux x64
  - dgn-edge-01: Linux ARM64
- **本地平台**：macOS ARM64

**结论**：必须在各设备本地构建，或在同架构 Linux 环境构建后分发。

---

## 四、后续执行方案

### 方案 A：审计后按需部署（推荐 ★★★★★）

#### 步骤
1. **审计服务端 API 变更**
   ```bash
   # 检查协议破坏性变更
   git diff HEAD server/app/api/sessions/[id]/route.ts
   git diff HEAD server/app/api/agent/[id]/route.ts
   
   # 若无破坏性变更 → 跳过服务端部署
   # 若有协议变更 → 必须同步升级
   ```

2. **若需部署，使用远程构建**
   ```bash
   # 登录 dgn-01（修复 SSH 或 tailscale ssh）
   ssh root@dgn-01
   
   # 切换到构建目录
   cd /root/pihub-build
   
   # 拉取最新代码
   git pull origin main
   
   # 安装依赖（锁定版本）
   npm ci
   
   # 构建服务端发布包
   node scripts/build-server-release.mjs
   
   # 安装到本地
   node scripts/install-server-release.mjs
   
   # 重启服务
   pm2 restart pihub-server
   ```

3. **分发到其他设备**
   ```bash
   # 在 dgn-01 执行
   scp dist/pihub-server-*.tar.gz root@ecs-01:/tmp/
   scp dist/pihub-server-*.tar.gz root@wsl-pc-01:/tmp/
   scp dist/pihub-server-*.tar.gz root@dgn-edge-01:/tmp/
   
   # 在各设备执行
   cd /tmp && tar -xzf pihub-server-*.tar.gz
   cd pihub-server-* && node install.mjs
   pm2 restart pihub-server
   ```

---

### 方案 B：本地安装 Node 22 构建（不推荐 ❌）

**问题**：
- 跨平台原生模块不兼容
- 即使构建成功，部署到 Linux 设备时 `node-pty` 会加载失败

**唯一可行场景**：
- 服务端代码完全去除原生依赖（不太可能）
- 或仅用于本地 Mac 上的测试服务端

---

### 方案 C：Docker 跨平台构建（未来优化）

```dockerfile
# 在本地构建 Linux x64 镜像
docker buildx build --platform linux/amd64 -t pihub-server:latest .

# 导出为 tar
docker save pihub-server:latest > pihub-server-linux-amd64.tar

# scp 到目标设备后 docker load
```

---

## 五、关键决策点

### 决策一：是否必须升级服务端？

**判断依据**：
```bash
# 检查 API 路由签名变更
git diff HEAD server/app/api/sessions/[id]/route.ts | grep "export.*function\|export.*GET\|export.*POST"

# 检查请求/响应结构变更
git diff HEAD server/app/api/sessions/[id]/route.ts | grep "Response\|Request\|interface"
```

**若输出为空** → 协议未变更，可跳过服务端部署  
**若有输出** → 必须同步升级

---

### 决策二：如何修复 dgn-01 SSH 连接？

**可能原因**：
1. SSH 密钥过期或被撤销
2. Tailscale ACL 规则变更
3. dgn-01 防火墙或 sshd 配置变更

**排查步骤**：
```bash
# 测试 Tailscale 连通性
tailscale ping dgn-01

# 测试 SSH 端口
nc -zv 100.x.x.x 22

# 查看 Tailscale SSH 日志
tailscale ssh --verbose root@dgn-01
```

---

### 决策三：Node 版本问题如何解决？

**临时方案**：在 dgn-01 上重新安装 Node 22
```bash
# 使用官方安装脚本
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# 或使用 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 22.19
nvm use 22.19
```

**长期方案**：项目添加 `.nvmrc` 或 `package.json` 中指定 `engines`
```json
{
  "engines": {
    "node": ">=22.19.0 <23.0.0"
  }
}
```

---

## 六、验证清单

### 桌面端验证
- [ ] 启动 PiHub Desktop
- [ ] 连接任一远程设备
- [ ] 加载会话列表（验证缓存命中）
- [ ] 打开既有会话（验证增量加载）
- [ ] 发送新消息（验证缓存更新）
- [ ] 重启 App（验证缓存持久化）

### 服务端验证（若升级）
- [ ] 4 台设备服务正常启动
- [ ] API 响应正常（`curl http://localhost:3456/api/sessions`）
- [ ] 日志无错误（`pm2 logs pihub-server`）
- [ ] 桌面端 "Agent request failed" 消失

---

## 七、回滚方案

### 桌面端回滚
```bash
# 恢复旧版
rm -rf "/Applications/PiHub Desktop.app"
mv "/Applications/PiHub Desktop.app.backup-20260822-000317" "/Applications/PiHub Desktop.app"
```

### 服务端回滚（若已升级）
```bash
# 在各设备执行
cd /opt/pihub-server
git checkout <上一个版本 commit SHA>
npm ci
pm2 restart pihub-server
```

---

## 八、联系人与权限

**SSH 访问**：
- dgn-01: `ssh root@dgn-01` 或 `tailscale ssh root@dgn-01`
- ecs-01: `ssh root@ecs-01`
- wsl-pc-01: `ssh root@wsl-pc-01`
- dgn-edge-01: `ssh root@dgn-edge-01`

**代码仓库**：
- 当前分支：`main`
- 最新 commit：`226db2d ci: satisfy shellcheck declaration warnings`
- Git 用户：`fooyao`

---

## 九、附录

### 附录 A：服务端构建脚本（待执行）

```bash
#!/bin/bash
# build-and-deploy.sh

set -e

DEVICES=("dgn-01" "ecs-01" "wsl-pc-01" "dgn-edge-01")
BUILD_DIR="/root/pihub-build"
INSTALL_DIR="/opt/pihub-server"

echo "=== 开始构建服务端 ==="

# 在 dgn-01 构建
ssh root@dgn-01 << 'EOF'
cd /root/pihub-build
git pull origin main
npm ci
node scripts/build-server-release.mjs
EOF

echo "=== 构建完成，开始分发 ==="

# 分发到所有设备
for device in "${DEVICES[@]}"; do
  echo "部署到 $device"
  scp root@dgn-01:/root/pihub-build/dist/pihub-server-*.tar.gz root@$device:/tmp/
  ssh root@$device << 'DEPLOY'
    cd /tmp
    tar -xzf pihub-server-*.tar.gz
    cd pihub-server-*
    node install.mjs
    pm2 restart pihub-server
    pm2 save
DEPLOY
done

echo "=== 部署完成 ==="
```

### 附录 B：API 变更审计脚本

```bash
#!/bin/bash
# audit-api-changes.sh

echo "=== 审计 API 路由签名变更 ==="
git diff HEAD server/app/api/sessions/[id]/route.ts | grep -E "^[+-].*export.*(GET|POST|PUT|DELETE|PATCH)"

echo "=== 审计请求/响应结构变更 ==="
git diff HEAD server/app/api/sessions/[id]/route.ts | grep -E "^[+-].*(interface|type).*\{" -A 10

echo "=== 审计 Agent API 变更 ==="
git diff HEAD server/app/api/agent/ | grep -E "^[+-].*export"
```

---

## 十、状态跟踪

| 任务 | 状态 | 完成时间 | 备注 |
|------|------|----------|------|
| 桌面端打包 | ✅ 完成 | 2026-08-22 00:03 | DMG 已生成 |
| 桌面端部署 | ✅ 完成 | 2026-08-22 00:03 | 本地 Mac 已安装 |
| 服务端审计 | ⏸️ 待执行 | - | 需审计 49 个文件改动 |
| 服务端构建 | ⏸️ 待执行 | - | 受阻于 Node 版本 + SSH |
| 服务端部署 | ⏸️ 待执行 | - | 4 台设备待升级 |

---

**最后更新**：2026-08-22 00:07  
**交接状态**：桌面端完成，服务端待决策
