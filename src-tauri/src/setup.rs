use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::bootstrap;
use crate::transport::tailscale_command;
use crate::util::{base64_encode, base64_url_encode};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BootstrapResult {
    success: bool,
    output: String,
    installed: bool,
    requires_approval: bool,
    approval_url: Option<String>,
}
pub(crate) const PIHUB_SERVER_VERSION: &str = "0.0.7";
pub(crate) const PIHUB_SERVER_RELEASE_OWNER: &str = "yourChainGod";
pub(crate) const PIHUB_SERVER_RELEASE_REPO: &str = "pihub";
pub(crate) const PIHUB_SERVER_RELEASE_CHANNEL: &str = "stable";
pub(crate) const PIHUB_SERVER_RELEASE_PUBLIC_KEY: &str =
    "2o1U_BIfYt1G_xYhSQBpAtHiQfTNi2ieUkxhvxBHkHI";
pub(crate) const PIHUB_SERVER_RELEASE_MANIFEST_URL: &str =
    "https://github.com/yourChainGod/pihub/releases/latest/download/release-manifest.json";
pub(crate) const PIHUB_PI_AGENT_PACKAGE: &str = "@earendil-works/pi-coding-agent";
pub(crate) const PIHUB_PI_AGENT_VERSION: &str = "0.84.2";
pub(crate) const PIHUB_NODE_VERSION: &str = "v22.23.2";
pub(crate) const PIHUB_NODE_LINUX_X64_SHA256: &str =
    "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307";
pub(crate) const PIHUB_NODE_LINUX_ARM64_SHA256: &str =
    "fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8";
pub(crate) const PIHUB_NODE_DARWIN_ARM64_SHA256: &str =
    "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6";
pub(crate) const PIHUB_NODE_DARWIN_X64_SHA256: &str =
    "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026";
#[derive(Clone, Copy)]
pub(crate) struct PinnedNpmPackage {
    name: &'static str,
    version: &'static str,
}

pub(crate) const PIHUB_EXTENSION_PACKAGES: [PinnedNpmPackage; 7] = [
    PinnedNpmPackage {
        name: "@cortexkit/pi-magic-context",
        version: "0.38.0",
    },
    PinnedNpmPackage {
        name: "pi-todo-rail",
        version: "0.2.3",
    },
    PinnedNpmPackage {
        name: "@ff-labs/pi-fff",
        version: "0.10.5",
    },
    PinnedNpmPackage {
        name: "pi-simplify",
        version: "0.2.3",
    },
    PinnedNpmPackage {
        name: "@gotgenes/pi-permission-system",
        version: "26.3.0",
    },
    PinnedNpmPackage {
        name: "@eko24ive/pi-ask",
        version: "1.2.0",
    },
    PinnedNpmPackage {
        name: "@gotgenes/pi-subagents",
        version: "19.3.2",
    },
];
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BundledVersions {
    pihub_server: &'static str,
    app: &'static str,
}

#[tauri::command]
pub(crate) fn bundled_versions() -> BundledVersions {
    BundledVersions {
        pihub_server: PIHUB_SERVER_VERSION,
        app: env!("CARGO_PKG_VERSION"),
    }
}
pub(crate) fn tailscale_approval_url(output: &str) -> Option<String> {
    let marker = "https://login.tailscale.com/";
    let start = output.find(marker)?;
    let value = output[start..].split_whitespace().next()?;
    Some(
        value
            .trim_end_matches([')', ']', '}', ',', '.', ';'])
            .to_owned(),
    )
}

pub(crate) fn render_standalone_bootstrap_helper() -> String {
    let packages = Value::Array(
        PIHUB_EXTENSION_PACKAGES
            .iter()
            .map(|package| {
                serde_json::json!({
                    "name": package.name,
                    "version": package.version,
                })
            })
            .collect(),
    );
    let packages = serde_json::to_vec(&packages).expect("fixed extension contract is serializable");
    include_str!("standalone_bootstrap.mjs")
        .replace("__RELEASE_OWNER__", PIHUB_SERVER_RELEASE_OWNER)
        .replace("__RELEASE_REPO__", PIHUB_SERVER_RELEASE_REPO)
        .replace("__RELEASE_CHANNEL__", PIHUB_SERVER_RELEASE_CHANNEL)
        .replace("__RELEASE_PUBLIC_KEY__", PIHUB_SERVER_RELEASE_PUBLIC_KEY)
        .replace(
            "__RELEASE_MANIFEST_URL__",
            PIHUB_SERVER_RELEASE_MANIFEST_URL,
        )
        .replace("__MINIMUM_SERVER_VERSION__", PIHUB_SERVER_VERSION)
        .replace("__PI_AGENT_PACKAGE__", PIHUB_PI_AGENT_PACKAGE)
        .replace("__PI_AGENT_VERSION__", PIHUB_PI_AGENT_VERSION)
        .replace("__EXTENSION_PACKAGES_BASE64__", &base64_encode(&packages))
}

pub(crate) fn selected_extension_argument(
    install_default_extensions: bool,
    selected_extensions: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    let names = selected_extensions.unwrap_or_else(|| {
        if install_default_extensions {
            PIHUB_EXTENSION_PACKAGES
                .iter()
                .map(|package| package.name.to_owned())
                .collect()
        } else {
            Vec::new()
        }
    });
    if names.len() > PIHUB_EXTENSION_PACKAGES.len() {
        return Err("插件选择数量无效".into());
    }
    let mut selected = Vec::with_capacity(names.len());
    let mut seen = HashSet::new();
    for name in names {
        if !seen.insert(name.clone()) {
            return Err("插件选择包含重复项".into());
        }
        let package = PIHUB_EXTENSION_PACKAGES
            .iter()
            .find(|package| package.name == name)
            .ok_or_else(|| "插件不在 PiHub 签名清单中".to_owned())?;
        selected.push(serde_json::json!({
            "name": package.name,
            "version": package.version,
        }));
    }
    if selected.is_empty() {
        return Ok(None);
    }
    let bytes = serde_json::to_vec(&selected).map_err(|_| "插件选择无法编码".to_owned())?;
    Ok(Some(base64_url_encode(&bytes)))
}

pub(crate) fn render_windows_bootstrap_script(selected: Option<&str>) -> String {
    include_str!("bootstrap_windows.ps1")
        .replace(
            "__STANDALONE_BOOTSTRAP__",
            &base64_encode(render_standalone_bootstrap_helper().as_bytes()),
        )
        .replace(
            "__EXTENSION_SELECTION_BASE64__",
            selected.unwrap_or_default(),
        )
}

pub(crate) const MAX_LOCAL_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

pub(crate) fn render_unix_bootstrap_script(
    selected: Option<&str>,
    allow_root: bool,
    local_archive_sha256: Option<&str>,
    auto_pair: bool,
) -> String {
    include_str!("bootstrap_unix.sh")
        .replace(
            "__STANDALONE_BOOTSTRAP__",
            &base64_encode(render_standalone_bootstrap_helper().as_bytes()),
        )
        .replace(
            "__EXTENSION_SELECTION_BASE64__",
            selected.unwrap_or_default(),
        )
        .replace("__PIHUB_ALLOW_ROOT__", if allow_root { "1" } else { "0" })
        .replace("__PIHUB_AUTO_PAIR__", if auto_pair { "1" } else { "0" })
        .replace(
            "__PIHUB_LOCAL_ARCHIVE__",
            if local_archive_sha256.is_some() {
                "1"
            } else {
                "0"
            },
        )
        .replace(
            "__PIHUB_LOCAL_ARCHIVE_SHA256__",
            local_archive_sha256.unwrap_or_default(),
        )
        .replace("__NODE_VERSION__", PIHUB_NODE_VERSION)
        .replace("__NODE_LINUX_X64_SHA256__", PIHUB_NODE_LINUX_X64_SHA256)
        .replace("__NODE_LINUX_ARM64_SHA256__", PIHUB_NODE_LINUX_ARM64_SHA256)
        .replace(
            "__NODE_DARWIN_ARM64_SHA256__",
            PIHUB_NODE_DARWIN_ARM64_SHA256,
        )
        .replace("__NODE_DARWIN_X64_SHA256__", PIHUB_NODE_DARWIN_X64_SHA256)
}

pub(crate) fn unix_bootstrap_ssh_user(
    os: Option<&str>,
    username: Option<&str>,
) -> Result<Option<String>, String> {
    let candidate = username.map(str::trim).filter(|value| !value.is_empty());
    let is_linux = os.is_some_and(|value| value.eq_ignore_ascii_case("linux"));
    if is_linux && candidate.is_none() {
        return Err("Linux Tailscale SSH 需要远端用户名".into());
    }
    // "root" is allowed: the desktop UI gates it behind an explicit danger
    // confirmation; the command boundary only enforces a well-formed name.
    candidate
        .map(|value| bootstrap::normalize_ssh_username(value, false))
        .transpose()
}

/// Probes the remote platform (`Linux x86_64` style) so the matching prebuilt
/// archive can be selected from the local release directory.
async fn probe_remote_platform(
    executable: &bootstrap::LocalExecutable,
    target: &str,
) -> Result<(String, String), String> {
    let output = bootstrap::run_bounded_command(
        bootstrap::BoundedCommand {
            executable: executable.clone(),
            args: vec!["ssh".into(), target.into(), "uname".into(), "-sm".into()],
            current_dir: None,
            stdin: bootstrap::BootstrapStdin::Raw(Vec::new()),
        },
        bootstrap::ProcessLimits {
            total_timeout: Duration::from_secs(30),
            capture_bytes_per_stream: 4 * 1024,
            log_line_bytes: 1,
            log_lines_per_stream: 1,
        },
        |_| {},
    )
    .await
    .map_err(|error| format!("目标平台探测失败（tailscale ssh uname）：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "目标平台探测失败：tailscale ssh 退出状态 {}",
            output.status
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let mut parts = text.split_whitespace();
    let platform = match parts.next() {
        Some("Linux") => "linux",
        Some("Darwin") => "darwin",
        _ => return Err(format!("本地直传暂不支持目标平台：{text}")),
    };
    let arch = match parts.next() {
        Some("x86_64" | "amd64") => "x64",
        Some("aarch64" | "arm64") => "arm64",
        _ => return Err(format!("本地直传暂不支持目标架构：{text}")),
    };
    Ok((platform.to_owned(), arch.to_owned()))
}

/// Reads and validates the `.sha256` sidecar of a local archive, returning the
/// recorded digest. Shared by archive selection and local update detection.
fn archive_sidecar_sha256(archive: &Path) -> Result<String, String> {
    let archive_name = archive
        .file_name()
        .ok_or("本地发布包文件名无效")?
        .to_string_lossy()
        .into_owned();
    let mut sha_name = archive
        .file_name()
        .ok_or("本地发布包文件名无效")?
        .to_os_string();
    sha_name.push(".sha256");
    let sha_path = archive.with_file_name(sha_name);
    let raw = fs::read_to_string(&sha_path)
        .map_err(|_| format!("本地发布包缺少同名校验文件：{archive_name}.sha256"))?;
    let mut tokens = raw.split_whitespace();
    let expected = tokens
        .next()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("本地发布包 .sha256 校验文件格式无效")?
        .to_owned();
    if let Some(recorded) = tokens.next() {
        let recorded = recorded
            .trim_start_matches('*')
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default();
        if recorded != archive_name {
            return Err("本地发布包与 .sha256 记录的文件名不一致".into());
        }
    }
    Ok(expected)
}

/// Locates `pihub-server-*-<platform>-<arch>.tar.gz` plus its `.sha256` sidecar
/// in the local release directory and cross-checks the recorded file name.
fn find_local_archive(
    directory: &Path,
    platform: &str,
    arch: &str,
) -> Result<(PathBuf, String), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("无法读取本地发布包目录 {directory:?}：{error}"))?;
    let suffix = format!("-{platform}-{arch}.tar.gz");
    let mut matches = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取本地发布包目录：{error}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("pihub-server-") && name.ends_with(&suffix) {
            matches.push(entry.path());
        }
    }
    // Multiple versions may accumulate; the highest name wins.
    matches.sort();
    let archive = matches.pop().ok_or_else(|| {
        format!(
            "本地发布包目录中没有匹配目标平台 {platform}-{arch} 的包（pihub-server-*-{platform}-{arch}.tar.gz）；请先在构建机上运行 node scripts/build-server-release.mjs --platform {platform} --arch {arch}"
        )
    })?;
    let expected = archive_sidecar_sha256(&archive)?;
    Ok((archive, expected))
}

/// Reads the selected archive (bounded) and verifies it against the sidecar
/// digest before any byte is sent to the remote host.
fn load_local_archive(
    directory: &str,
    platform: &str,
    arch: &str,
) -> Result<(Vec<u8>, String), String> {
    let (archive, expected) = find_local_archive(Path::new(directory), platform, arch)?;
    let size = fs::metadata(&archive)
        .map_err(|error| format!("无法读取本地发布包：{error}"))?
        .len();
    if size == 0 || size > MAX_LOCAL_ARCHIVE_BYTES {
        return Err("本地发布包大小超过 512MB 上限或为空".into());
    }
    let bytes = fs::read(&archive).map_err(|error| format!("无法读取本地发布包：{error}"))?;
    let actual = hex::encode(Sha256::digest(&bytes));
    if actual != expected {
        return Err("本地发布包内容与 .sha256 校验和不一致，已拒绝发送".into());
    }
    Ok((bytes, expected))
}

/// Parses `pihub-server-<version>-<platform>-<arch>.tar.gz` for the given
/// platform (any arch), returning the semantic version of the asset.
fn parse_local_archive_version(name: &str, platform: &str) -> Option<semver::Version> {
    let stem = name
        .strip_prefix("pihub-server-")?
        .strip_suffix(".tar.gz")?;
    let (version, arch) = stem.split_once(&format!("-{platform}-"))?;
    if arch.is_empty() {
        return None;
    }
    semver::Version::parse(version).ok()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalServerUpdate {
    latest: String,
    archive_name: String,
    update_available: bool,
    pi: LocalComponentVersion,
    extensions: Vec<LocalComponentVersion>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalComponentVersion {
    name: String,
    version: String,
}

/// Component versions bundled into the desktop build; used when the selected
/// archive has no readable `.asset.json` component metadata.
fn compiled_in_components() -> (LocalComponentVersion, Vec<LocalComponentVersion>) {
    (
        LocalComponentVersion {
            name: PIHUB_PI_AGENT_PACKAGE.to_owned(),
            version: PIHUB_PI_AGENT_VERSION.to_owned(),
        },
        PIHUB_EXTENSION_PACKAGES
            .iter()
            .map(|package| LocalComponentVersion {
                name: package.name.to_owned(),
                version: package.version.to_owned(),
            })
            .collect(),
    )
}

fn valid_component_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'/' | b'.' | b'_' | b'-')
        })
}

fn valid_component_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
}

/// Reads the `<base>.asset.json` sibling of the selected archive for the pi
/// runtime and extension versions the archive bundles. Any inconsistency falls
/// back to the compiled-in pins rather than failing the update check.
fn local_archive_components(
    directory: &Path,
    archive_name: &str,
) -> (LocalComponentVersion, Vec<LocalComponentVersion>) {
    let fallback = || compiled_in_components();
    let Some(base) = archive_name.strip_suffix(".tar.gz") else {
        return fallback();
    };
    if base.is_empty() || base.contains(['/', '\\']) {
        return fallback();
    }
    let Ok(raw) = fs::read(directory.join(format!("{base}.asset.json"))) else {
        return fallback();
    };
    if raw.len() > 64 * 1024 {
        return fallback();
    }
    let Ok(asset) = serde_json::from_slice::<Value>(&raw) else {
        return fallback();
    };
    if asset.get("filename").and_then(Value::as_str) != Some(archive_name) {
        return fallback();
    }
    let parse_component = |value: &Value| -> Option<LocalComponentVersion> {
        let name = value.get("name")?.as_str()?;
        let version = value.get("version")?.as_str()?;
        (valid_component_name(name) && valid_component_version(version)).then(|| {
            LocalComponentVersion {
                name: name.to_owned(),
                version: version.to_owned(),
            }
        })
    };
    let Some(pi) = asset.get("pi").and_then(&parse_component) else {
        return fallback();
    };
    let Some(extensions) = asset.get("extensions").and_then(Value::as_array) else {
        return fallback();
    };
    let extensions: Option<Vec<LocalComponentVersion>> =
        extensions.iter().map(parse_component).collect();
    match extensions {
        Some(extensions) if !extensions.is_empty() => (pi, extensions),
        _ => fallback(),
    }
}

/// Scans the local release directory for the newest installable asset matching
/// the target platform (any arch; the bootstrap transfer probes the arch
/// itself). Purely local: no network access and no GitHub manifest.
#[tauri::command]
pub(crate) fn check_local_server_update(
    directory: String,
    platform: String,
    current_version: Option<String>,
) -> Result<LocalServerUpdate, String> {
    let platform = platform.trim().to_owned();
    match platform.as_str() {
        "linux" | "darwin" => {}
        "win32" | "windows" => return Err("Windows 目标暂不支持直传更新".into()),
        _ => return Err(format!("本地直传不支持目标平台：{platform}")),
    }
    let directory = directory.trim();
    if directory.is_empty() {
        return Err("未配置本地发布包目录".into());
    }
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("无法读取本地发布包目录 {directory}：{error}"))?;
    let mut best: Option<(semver::Version, String)> = None;
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取本地发布包目录：{error}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(version) = parse_local_archive_version(&name, &platform) else {
            continue;
        };
        // Only archives with a valid checksum sidecar are installable.
        if archive_sidecar_sha256(&entry.path()).is_err() {
            continue;
        }
        let newer = match &best {
            Some((current, _)) => version > *current,
            None => true,
        };
        if newer {
            best = Some((version, name));
        }
    }
    let (latest, archive_name) = best.ok_or_else(|| {
        format!(
            "本地发布包目录中没有匹配 {platform} 平台的发布包（pihub-server-*-{platform}-*.tar.gz）；请先在构建机上运行 node scripts/build-server-release.mjs"
        )
    })?;
    let (pi, extensions) = local_archive_components(Path::new(directory), &archive_name);
    let update_available = match current_version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| semver::Version::parse(value.trim_start_matches('v')).ok())
    {
        Some(current) => latest > current,
        None => true,
    };
    Ok(LocalServerUpdate {
        latest: latest.to_string(),
        archive_name,
        update_available,
        pi,
        extensions,
    })
}

#[tauri::command]
pub(crate) fn open_tailscale_approval(app: AppHandle, url: String) -> Result<(), String> {
    if url.len() > 4096 || url.chars().any(char::is_control) {
        return Err("无效的 Tailscale 授权地址".into());
    }
    let parsed = url::Url::parse(&url).map_err(|_| "无效的 Tailscale 授权地址")?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("login.tailscale.com")
        || parsed.port_or_known_default() != Some(443)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err("只允许打开 Tailscale 官方授权地址".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<String>)
        .map_err(|error| format!("无法打开授权页面：{error}"))
}

// Tauri commands take flat IPC arguments; bundling would change the JS contract.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn bootstrap_tailnet_peer(
    app: AppHandle,
    host: String,
    os: Option<String>,
    username: Option<String>,
    install_default_extensions: bool,
    selected_extensions: Option<Vec<String>>,
    local_archive_dir: Option<String>,
    auto_pair: Option<bool>,
) -> Result<BootstrapResult, String> {
    let normalized = bootstrap::normalize_tailscale_host(&host)?;
    let selected_argument =
        selected_extension_argument(install_default_extensions, selected_extensions)?;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let local_archive_dir = local_archive_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let is_windows = os
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("windows"));
    if is_windows && local_archive_dir.is_some() {
        return Err("本地直传暂不支持 Windows 目标".into());
    }
    let specification = if is_windows {
        let user = username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or("Windows OpenSSH 需要远端 Windows 用户名")?;
        let executable = bootstrap::discover_ssh_executable()
            .ok_or("未找到系统 OpenSSH 客户端；请安装或启用 OpenSSH Client 后重试")?;
        let args = bootstrap::windows_ssh_args(user, &normalized)?;
        let script = render_windows_bootstrap_script(selected_argument.as_deref());
        bootstrap::BoundedCommand {
            executable,
            args,
            current_dir: Some(config_dir.clone()),
            stdin: bootstrap::BootstrapStdin::WindowsFrame { script },
        }
    } else {
        let executable = tailscale_command().ok_or("未找到 Tailscale 客户端")?;
        let ssh_user = unix_bootstrap_ssh_user(os.as_deref(), username.as_deref())?;
        // The desktop UI gates root installs behind an explicit danger
        // confirmation; reaching this point with root means it was confirmed.
        let allow_root = ssh_user.as_deref() == Some("root");
        let target = ssh_user
            .map(|user| format!("{user}@{normalized}"))
            .unwrap_or_else(|| normalized.clone());
        // Local direct-transfer mode: probe the target platform, then upload a
        // prebuilt archive through stdin instead of downloading from GitHub.
        let local_archive = match local_archive_dir {
            None => None,
            Some(directory) => {
                let (platform, arch) = probe_remote_platform(&executable, &target).await?;
                Some(load_local_archive(directory, &platform, &arch)?)
            }
        };
        let script = render_unix_bootstrap_script(
            selected_argument.as_deref(),
            allow_root,
            local_archive.as_ref().map(|(_, sha256)| sha256.as_str()),
            auto_pair.unwrap_or(false),
        );
        bootstrap::BoundedCommand {
            executable,
            args: vec!["ssh".into(), target.into(), script.into()],
            current_dir: Some(config_dir),
            stdin: bootstrap::BootstrapStdin::Raw(
                local_archive.map(|(bytes, _)| bytes).unwrap_or_default(),
            ),
        }
    };
    let app_handle = app.clone();
    let result = bootstrap::run_bounded_command(
        specification,
        bootstrap::ProcessLimits::default(),
        move |event| {
            let _ = app_handle.emit(
                "pihub-bootstrap-log",
                serde_json::json!({ "stream": event.stream, "line": event.line }),
            );
        },
    )
    .await
    .map_err(|error| format!("远程配置进程失败：{error}"))?;
    let mut combined = format!(
        "{}{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    if result.stdout_truncated {
        combined.push_str("\n[pihub] 标准输出超过安全上限，以上内容已截断");
    }
    if result.stderr_truncated {
        combined.push_str("\n[pihub] 错误输出超过安全上限，以上内容已截断");
    }
    if let Some(error) = result.input_error {
        combined.push_str(&format!("\n[pihub] 输入传输提前结束：{error}"));
    }
    if !result.status.success() {
        return Err(if combined.trim().is_empty() {
            format!(
                "远程配置进程退出：{}（远端没有任何输出，请查看输出面板或手动 SSH 排查）",
                result.status
            )
        } else {
            combined
        });
    }
    let approval_url = tailscale_approval_url(&combined);
    Ok(BootstrapResult {
        success: true,
        installed: combined.contains("PIHUB_SERVER_INSTALLED"),
        requires_approval: approval_url.is_some(),
        approval_url,
        output: combined,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_bootstrap_script_embeds_the_signed_standalone_installer() {
        let script = render_windows_bootstrap_script(Some("selection"));
        assert!(script.starts_with("$ErrorActionPreference = 'Stop'"));
        assert!(script.contains("PIHUB_BOOTSTRAP_OK"));
        assert!(script.contains("major>22||(major===22&&minor>=19)"));
        assert!(script.contains("--with-extensions=selection"));
        assert!(!script.contains("npm install"));
        assert!(!script.contains("npm.cmd"));
        assert!(!script.contains("npx"));
        assert!(!script.contains("pihub-server.tgz"));
        assert!(!script.contains("__STANDALONE_BOOTSTRAP__"));
        assert!(!script.contains("__INSTALL_EXTENSIONS__"));
        assert!(!script.contains("OpenStandardInput"));
        assert!(script.len() <= bootstrap::MAX_BOOTSTRAP_SCRIPT_BYTES);
    }

    #[test]
    fn linux_bootstrap_requires_an_explicit_ssh_user_and_allows_confirmed_root() {
        assert_eq!(
            unix_bootstrap_ssh_user(Some("linux"), Some("pi-user")).unwrap(),
            Some("pi-user".into())
        );
        assert!(unix_bootstrap_ssh_user(Some("Linux"), None).is_err());
        // root is permitted; the desktop UI requires explicit confirmation first.
        assert_eq!(
            unix_bootstrap_ssh_user(Some("linux"), Some("root")).unwrap(),
            Some("root".into())
        );
        assert_eq!(unix_bootstrap_ssh_user(Some("macos"), None).unwrap(), None);
    }

    #[test]
    fn unix_bootstrap_is_posix_and_verifies_downloaded_node_archives() {
        let script = render_unix_bootstrap_script(None, false, None, false);
        assert!(script.starts_with("set -eu\n"));
        assert!(script.contains("PIHUB_ALLOW_ROOT=\"0\""));
        assert!(render_unix_bootstrap_script(None, true, None, false)
            .contains("PIHUB_ALLOW_ROOT=\"1\""));
        assert!(script.contains("PIHUB_AUTO_PAIR=\"0\""));
        assert!(script.contains("[ \"0\" = \"1\" ]"));
        assert!(script.contains("trap cleanup 0"));
        assert!(!script.contains("trap '"));
        assert!(!script.contains(" ERR"));
        assert!(script.contains(PIHUB_NODE_LINUX_X64_SHA256));
        assert!(script.contains(PIHUB_NODE_LINUX_ARM64_SHA256));
        assert!(script.contains(PIHUB_NODE_DARWIN_X64_SHA256));
        assert!(script.contains(PIHUB_NODE_DARWIN_ARM64_SHA256));
        assert!(script.contains("actual_sha256"));
        assert!(script.contains("https://nodejs.org/dist/"));
        assert!(script.contains("node \"$installer\""));
        assert!(!script.contains("npm install"));
        assert!(!script.contains("npx"));
        assert!(!script.contains("pihub-server.tgz"));
        assert!(!script.contains("--location"));
        assert!(!script.contains("__STANDALONE_BOOTSTRAP__"));
        assert!(!script.contains("__INSTALL_EXTENSIONS__"));
        assert!(!script.contains("__NODE_"));
        assert!(!script.contains("__PIHUB_"));
        assert!(script.len() <= bootstrap::MAX_BOOTSTRAP_SCRIPT_BYTES);
    }

    #[test]
    fn unix_bootstrap_local_archive_mode_renders_stdin_staging() {
        let sha256 = "a".repeat(64);
        let script = render_unix_bootstrap_script(None, false, Some(&sha256), true);
        assert!(script.contains("PIHUB_AUTO_PAIR=\"1\""));
        assert!(script.contains("[ \"1\" = \"1\" ]"));
        assert!(script.contains("cat > \"$tmp/server.tgz\""));
        assert!(script.contains(&format!("PIHUB_LOCAL_ARCHIVE_SHA256=\"{sha256}\"")));
        assert!(script.contains("export PIHUB_LOCAL_ARCHIVE=\"$tmp/server.tgz\""));
        assert!(!script.contains("__PIHUB_"));
        assert!(script.len() <= bootstrap::MAX_BOOTSTRAP_SCRIPT_BYTES);
    }

    fn local_archive_test_directory(label: &str) -> PathBuf {
        let mut random = [0u8; 12];
        getrandom::fill(&mut random).unwrap();
        let directory = std::env::temp_dir().join(format!(
            "pihub-local-archive-test-{label}-{}-{random:?}",
            std::process::id(),
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn local_archive_selection_requires_a_matching_platform_asset() {
        let directory = local_archive_test_directory("missing");
        let error = find_local_archive(&directory, "linux", "x64").unwrap_err();
        assert!(error.contains("build-server-release"), "{error}");
        fs::write(
            directory.join("pihub-server-0.0.1-darwin-arm64.tar.gz"),
            b"other",
        )
        .unwrap();
        // A different platform/arch in the directory must not match.
        let error = find_local_archive(&directory, "linux", "x64").unwrap_err();
        assert!(error.contains("build-server-release"), "{error}");
        // Matching name without the sidecar digest is rejected.
        let archive = directory.join("pihub-server-0.0.1-linux-x64.tar.gz");
        fs::write(&archive, b"payload").unwrap();
        let error = find_local_archive(&directory, "linux", "x64").unwrap_err();
        assert!(error.contains(".sha256"), "{error}");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn local_archive_load_verifies_the_sidecar_digest_and_name() {
        let directory = local_archive_test_directory("verify");
        let payload = b"fake-archive-bytes";
        let archive = directory.join("pihub-server-0.0.1-linux-x64.tar.gz");
        fs::write(&archive, payload).unwrap();
        let digest = hex::encode(Sha256::digest(payload));

        // Wrong recorded file name is rejected.
        fs::write(
            directory.join("pihub-server-0.0.1-linux-x64.tar.gz.sha256"),
            format!("{digest}  pihub-server-0.0.1-linux-arm64.tar.gz\n"),
        )
        .unwrap();
        assert!(find_local_archive(&directory, "linux", "x64").is_err());

        fs::write(
            directory.join("pihub-server-0.0.1-linux-x64.tar.gz.sha256"),
            format!("{digest}  pihub-server-0.0.1-linux-x64.tar.gz\n"),
        )
        .unwrap();
        let (bytes, sha256) =
            load_local_archive(directory.to_str().unwrap(), "linux", "x64").unwrap();
        assert_eq!(bytes, payload);
        assert_eq!(sha256, digest);

        // Content tampering after the digest was recorded is rejected.
        fs::write(&archive, b"tampered").unwrap();
        let error = load_local_archive(directory.to_str().unwrap(), "linux", "x64").unwrap_err();
        assert!(error.contains("校验和不一致"), "{error}");
        fs::remove_dir_all(directory).unwrap();
    }

    fn write_local_archive(directory: &Path, name: &str) {
        let payload = format!("payload-{name}");
        fs::write(directory.join(name), &payload).unwrap();
        let digest = hex::encode(Sha256::digest(payload.as_bytes()));
        fs::write(
            directory.join(format!("{name}.sha256")),
            format!("{digest}  {name}\n"),
        )
        .unwrap();
    }

    #[test]
    fn local_update_check_picks_the_highest_version_with_a_valid_sidecar() {
        let directory = local_archive_test_directory("update-check");
        write_local_archive(&directory, "pihub-server-0.0.1-linux-x64.tar.gz");
        write_local_archive(&directory, "pihub-server-0.2.0-linux-arm64.tar.gz");
        write_local_archive(&directory, "pihub-server-0.10.0-linux-x64.tar.gz");
        // A higher version without a sidecar is not installable and is skipped.
        fs::write(
            directory.join("pihub-server-0.11.0-linux-x64.tar.gz"),
            b"payload",
        )
        .unwrap();
        // Other platforms and unparseable versions never match.
        write_local_archive(&directory, "pihub-server-9.9.9-darwin-arm64.tar.gz");
        write_local_archive(&directory, "pihub-server-beta-linux-x64.tar.gz");

        let result = check_local_server_update(
            directory.to_str().unwrap().into(),
            "linux".into(),
            Some("0.0.1".into()),
        )
        .unwrap();
        assert_eq!(result.latest, "0.10.0");
        assert_eq!(result.archive_name, "pihub-server-0.10.0-linux-x64.tar.gz");
        assert!(result.update_available);

        let up_to_date = check_local_server_update(
            directory.to_str().unwrap().into(),
            "linux".into(),
            Some("0.10.0".into()),
        )
        .unwrap();
        assert!(!up_to_date.update_available);
        let newer_local = check_local_server_update(
            directory.to_str().unwrap().into(),
            "linux".into(),
            Some("1.0.0".into()),
        )
        .unwrap();
        assert!(!newer_local.update_available);
        // Unknown current version means an update is always offered.
        let unknown =
            check_local_server_update(directory.to_str().unwrap().into(), "linux".into(), None)
                .unwrap();
        assert!(unknown.update_available);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn local_update_check_reads_component_versions_from_the_asset_sidecar() {
        let directory = local_archive_test_directory("update-components");
        write_local_archive(&directory, "pihub-server-0.2.0-linux-x64.tar.gz");

        // No asset sidecar: fall back to the compiled-in pins.
        let result =
            check_local_server_update(directory.to_str().unwrap().into(), "linux".into(), None)
                .unwrap();
        assert_eq!(result.pi.name, PIHUB_PI_AGENT_PACKAGE);
        assert_eq!(result.pi.version, PIHUB_PI_AGENT_VERSION);
        assert_eq!(result.extensions.len(), PIHUB_EXTENSION_PACKAGES.len());

        // A matching asset sidecar reports the archive's own component versions.
        fs::write(
            directory.join("pihub-server-0.2.0-linux-x64.asset.json"),
            r#"{
              "schemaVersion": 1,
              "filename": "pihub-server-0.2.0-linux-x64.tar.gz",
              "pi": { "name": "@earendil-works/pi-coding-agent", "version": "9.9.9" },
              "extensions": [{ "name": "pi-todo-rail", "version": "8.8.8" }]
            }"#,
        )
        .unwrap();
        let result =
            check_local_server_update(directory.to_str().unwrap().into(), "linux".into(), None)
                .unwrap();
        assert_eq!(result.pi.version, "9.9.9");
        assert_eq!(result.extensions.len(), 1);
        assert_eq!(result.extensions[0].name, "pi-todo-rail");
        assert_eq!(result.extensions[0].version, "8.8.8");

        // A sidecar recorded for a different archive is ignored.
        fs::write(
            directory.join("pihub-server-0.2.0-linux-x64.asset.json"),
            r#"{
              "filename": "pihub-server-9.9.9-linux-x64.tar.gz",
              "pi": { "name": "@earendil-works/pi-coding-agent", "version": "9.9.9" },
              "extensions": [{ "name": "pi-todo-rail", "version": "8.8.8" }]
            }"#,
        )
        .unwrap();
        let result =
            check_local_server_update(directory.to_str().unwrap().into(), "linux".into(), None)
                .unwrap();
        assert_eq!(result.pi.version, PIHUB_PI_AGENT_VERSION);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn local_update_check_rejects_unsupported_platforms_and_empty_directories() {
        let error = check_local_server_update("/tmp".into(), "win32".into(), None).unwrap_err();
        assert!(error.contains("Windows 目标暂不支持直传更新"), "{error}");
        let error = check_local_server_update("/tmp".into(), "freebsd".into(), None).unwrap_err();
        assert!(error.contains("不支持目标平台"), "{error}");
        let error = check_local_server_update(
            "/definitely/missing/pihub-release-dir".into(),
            "linux".into(),
            None,
        )
        .unwrap_err();
        assert!(error.contains("无法读取本地发布包目录"), "{error}");
        let directory = local_archive_test_directory("update-empty");
        write_local_archive(&directory, "pihub-server-0.0.1-darwin-arm64.tar.gz");
        let error =
            check_local_server_update(directory.to_str().unwrap().into(), "linux".into(), None)
                .unwrap_err();
        assert!(error.contains("没有匹配 linux 平台"), "{error}");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn standalone_helper_pins_release_trust_and_extension_contract() {
        let helper = render_standalone_bootstrap_helper();
        assert!(helper.contains(PIHUB_SERVER_RELEASE_OWNER));
        assert!(helper.contains(PIHUB_SERVER_RELEASE_REPO));
        assert!(helper.contains(PIHUB_SERVER_RELEASE_CHANNEL));
        assert!(helper.contains(PIHUB_SERVER_RELEASE_PUBLIC_KEY));
        assert!(helper.contains(PIHUB_SERVER_RELEASE_MANIFEST_URL));
        assert!(helper.contains(PIHUB_SERVER_VERSION));
        assert!(helper.contains(PIHUB_PI_AGENT_PACKAGE));
        assert!(helper.contains(PIHUB_PI_AGENT_VERSION));
        for package in PIHUB_EXTENSION_PACKAGES {
            let contract = base64_encode(
                serde_json::to_vec(&serde_json::json!(PIHUB_EXTENSION_PACKAGES
                    .iter()
                    .map(|entry| serde_json::json!({
                        "name": entry.name,
                        "version": entry.version,
                    }))
                    .collect::<Vec<_>>()))
                .unwrap()
                .as_slice(),
            );
            assert!(helper.contains(&contract));
            assert!(!package.name.is_empty());
            assert!(!package.version.is_empty());
        }
        assert!(!helper.contains("npm install"));
        assert!(!helper.contains("npm.cmd"));
        assert!(!helper.contains("npx"));
        assert!(!helper.contains("__RELEASE_"));
        assert!(!helper.contains("__MINIMUM_"));
        assert!(!helper.contains("__PI_AGENT_"));
        assert!(!helper.contains("__EXTENSION_"));
        assert!(!helper.contains("__PERMISSION_"));
        assert!(helper.contains("pi-magic-context"));
        assert!(helper.contains("pi-todo-rail"));
    }

    #[cfg(unix)]
    #[test]
    fn rendered_unix_bootstrap_passes_the_system_shell_parser() {
        use std::io::Write as _;

        for script in [
            render_unix_bootstrap_script(Some("selection"), false, None, false),
            render_unix_bootstrap_script(Some("selection"), true, Some(&"a".repeat(64)), true),
        ] {
            let mut child = std::process::Command::new("/bin/sh")
                .arg("-n")
                .stdin(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(script.as_bytes())
                .unwrap();
            assert!(child.wait().unwrap().success());
        }
    }

    #[cfg(windows)]
    #[test]
    fn rendered_windows_bootstrap_passes_the_system_powershell_parser() {
        use std::io::Write as _;

        let script = render_windows_bootstrap_script(Some("selection"));
        let mut child = std::process::Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors)|Out-Null; if($errors.Count -ne 0){ $errors | Out-String | Write-Error; exit 1 }",
            ])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        assert!(child.wait().unwrap().success());
    }
}
