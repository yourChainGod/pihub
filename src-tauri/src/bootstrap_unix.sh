set -eu

step=初始化
tmp=$(mktemp -d)

cleanup() {
  status=$?
  trap - 0
  rm -rf "$tmp" || true
  if [ "$status" -ne 0 ]; then
    printf '%s\n' "[pihub] 失败于步骤：$step（退出码 $status）" >&2
  fi
  exit "$status"
}
trap cleanup 0

echo '[pihub] 已连接，正在准备 GitHub 签名版服务…'

step=环境检查
for directory in "$HOME"/.local/share/pi-node/node-*/bin; do
  if [ -d "$directory" ]; then
    PATH="$directory:$PATH"
  fi
done
export PATH="$HOME/.local/bin:$PATH"

node_compatible() {
  command -v node >/dev/null 2>&1 && node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'
}

download_file() {
  source_url=$1
  output_path=$2
  if command -v curl >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 --fail --silent --show-error --connect-timeout 15 --max-time 180 --max-redirs 0 "$source_url" --output "$output_path"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --https-only --timeout=30 --tries=1 --max-redirect=0 --output-document="$output_path" "$source_url"
  else
    return 127
  fi
}

if ! node_compatible; then
  step=安装Node.js
  echo '[pihub] 正在安装经过校验的 Node.js __NODE_VERSION__…'
  case "$(uname -sm)" in
    'Linux x86_64')
      node_platform=linux-x64
      node_sha256=__NODE_LINUX_X64_SHA256__
      ;;
    'Linux aarch64'|'Linux arm64')
      node_platform=linux-arm64
      node_sha256=__NODE_LINUX_ARM64_SHA256__
      ;;
    'Darwin arm64')
      node_platform=darwin-arm64
      node_sha256=__NODE_DARWIN_ARM64_SHA256__
      ;;
    'Darwin x86_64')
      node_platform=darwin-x64
      node_sha256=__NODE_DARWIN_X64_SHA256__
      ;;
    *)
      printf '%s\n' "[pihub] 不支持自动安装 Node 的平台：$(uname -sm)" >&2
      exit 1
      ;;
  esac

  node_archive="$tmp/node.tar.gz"
  node_filename="node-__NODE_VERSION__-$node_platform.tar.gz"
  download_file "https://nodejs.org/dist/__NODE_VERSION__/$node_filename" "$node_archive" || {
    echo '[pihub] Node.js 下载失败，请检查网络后重试' >&2
    exit 1
  }
  node_bytes=$(wc -c < "$node_archive" | tr -d ' ')
  if [ "$node_bytes" -le 0 ] || [ "$node_bytes" -gt 209715200 ]; then
    echo '[pihub] Node.js 下载大小异常，已拒绝执行' >&2
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha256=$(sha256sum "$node_archive" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual_sha256=$(shasum -a 256 "$node_archive" | awk '{print $1}')
  else
    echo '[pihub] 系统缺少 SHA-256 校验工具，已拒绝执行下载内容' >&2
    exit 1
  fi
  if [ "$actual_sha256" != "$node_sha256" ]; then
    echo '[pihub] Node.js 下载内容校验失败，已拒绝执行' >&2
    exit 1
  fi

  node_stage="$tmp/node"
  mkdir -p "$node_stage"
  tar -xzf "$node_archive" -C "$node_stage"
  node_source="$node_stage/node-__NODE_VERSION__-$node_platform"
  if [ ! -x "$node_source/bin/node" ]; then
    echo '[pihub] Node.js 归档结构无效，已拒绝执行' >&2
    exit 1
  fi
  mkdir -p "$HOME/.local/share/pi-node"
  node_target="$HOME/.local/share/pi-node/node-__NODE_VERSION__-$node_platform"
  if [ ! -d "$node_target" ]; then
    mv "$node_source" "$node_target"
  fi
  PATH="$node_target/bin:$PATH"
  export PATH
fi

if ! node_compatible; then
  echo '[pihub] Node.js 自动安装失败，请手动安装 22.19+ 后重试' >&2
  exit 1
fi
echo "[pihub] Node $(node -v)"

if ! command -v tailscale >/dev/null 2>&1; then
  echo '[pihub] 未找到 Tailscale CLI' >&2
  exit 1
fi

PI_SETTINGS="$HOME/.pi/agent/settings.json"
old_pid=$(ps -eo pid=,args= | awk '$0 ~ /[p]i-web/ && $0 !~ /pihub/ {print $1}' || true)
if [ -n "$old_pid" ]; then
  kill $old_pid || true
  sleep 1
fi

if [ -f "$PI_SETTINGS" ] && grep -q 'pi-provider-newapi-hdd' "$PI_SETTINGS"; then
  cp "$PI_SETTINGS" "$PI_SETTINGS.pihub-backup-$(date +%Y%m%d-%H%M%S)"
  node -e 'const fs=require("fs"),p=process.argv[1],j=JSON.parse(fs.readFileSync(p,"utf8"));j.packages=(j.packages||[]).filter(x=>!String(x).includes("pi-provider-newapi-hdd"));fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n",{mode:384})' "$PI_SETTINGS"
  echo PIHUB_LEGACY_PROVIDER_REMOVED
fi

step=安装GitHub签名服务
installer="$tmp/pihub-standalone-bootstrap.mjs"
node -e 'require("fs").writeFileSync(process.argv[2],Buffer.from(process.argv[1],"base64"),{flag:"wx",mode:384})' '__STANDALONE_BOOTSTRAP__' "$installer"
if [ '__INSTALL_EXTENSIONS__' = '1' ]; then
  node "$installer" --with-extensions
else
  node "$installer"
fi

step=配置TailscaleServe
if tailscale serve status --json 2>/dev/null | node -e 'try { const v=JSON.parse(require("fs").readFileSync(0,"utf8")); const tcp=v.TCP?.["30141"]?.HTTPS===true; const web=Object.values(v.Web||{}).some(x=>x?.Handlers?.["/"]?.Proxy==="http://127.0.0.1:30141"); process.exit(tcp&&web?0:1) } catch { process.exit(1) }'; then
  echo PIHUB_SERVE_SKIPPED
else
  serve_file="$tmp/serve.out"
  tailscale serve --bg --https=30141 http://127.0.0.1:30141 >"$serve_file" 2>&1 &
  serve_pid=$!
  (sleep 15; kill "$serve_pid" 2>/dev/null || true) &
  watchdog_pid=$!
  serve_status=0
  wait "$serve_pid" || serve_status=$?
  kill "$watchdog_pid" 2>/dev/null || true
  serve_output=$(cat "$serve_file")
  if [ "$serve_status" -ne 0 ]; then
    approval_url=$(printf '%s' "$serve_output" | grep -o 'https://login\.tailscale\.com/[^[:space:]]*' | head -n 1 || true)
    if [ -n "$approval_url" ]; then
      printf 'PIHUB_SERVE_APPROVAL=%s\n' "$approval_url"
    else
      printf '%s\n' "$serve_output" >&2
      exit "$serve_status"
    fi
  fi
fi

echo PIHUB_BOOTSTRAP_OK
