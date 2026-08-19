mod bootstrap;
mod desktop_updater;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use bytes::Bytes;
use hmac::{Hmac, Mac};
use percent_encoding::{AsciiSet, CONTROLS};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
#[cfg(windows)]
use std::os::windows::{
    ffi::OsStrExt as _,
    fs::{MetadataExt as _, OpenOptionsExt as _},
};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Device {
    id: String,
    name: String,
    host: String,
    url: String,
    source: String,
    favorite: bool,
    accent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    os: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDeviceImportResult {
    devices: Vec<Device>,
    imported: usize,
    skipped: usize,
    backup: Option<String>,
    credentials_migrated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceStatus {
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    latency_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TailnetPeer {
    id: String,
    name: String,
    host: String,
    dns_name: Option<String>,
    ip: String,
    os: Option<String>,
    online: bool,
    is_self: bool,
    pi_web: bool,
    requires_auth: bool,
    url: String,
    latency_ms: Option<u128>,
    version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TailnetScan {
    available: bool,
    tailnet: Option<String>,
    peers: Vec<TailnetPeer>,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapResult {
    success: bool,
    output: String,
    installed: bool,
    requires_approval: bool,
    approval_url: Option<String>,
}

const PIHUB_SERVER_VERSION: &str = "0.0.1";
const PIHUB_SERVER_RELEASE_OWNER: &str = "yourChainGod";
const PIHUB_SERVER_RELEASE_REPO: &str = "pihub";
const PIHUB_SERVER_RELEASE_CHANNEL: &str = "stable";
const PIHUB_SERVER_RELEASE_PUBLIC_KEY: &str = "2o1U_BIfYt1G_xYhSQBpAtHiQfTNi2ieUkxhvxBHkHI";
const PIHUB_SERVER_RELEASE_MANIFEST_URL: &str =
    "https://github.com/yourChainGod/pihub/releases/latest/download/release-manifest.json";
const PIHUB_PI_AGENT_PACKAGE: &str = "@earendil-works/pi-coding-agent";
const PIHUB_PI_AGENT_VERSION: &str = "0.84.2";
const PIHUB_NODE_VERSION: &str = "v22.23.2";
const PIHUB_NODE_LINUX_X64_SHA256: &str =
    "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a";
const PIHUB_NODE_LINUX_ARM64_SHA256: &str =
    "013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30";
const PIHUB_NODE_DARWIN_ARM64_SHA256: &str =
    "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6";
const PIHUB_NODE_DARWIN_X64_SHA256: &str =
    "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026";
#[derive(Clone, Copy)]
struct PinnedNpmPackage {
    name: &'static str,
    version: &'static str,
}

const PIHUB_EXTENSION_PACKAGES: [PinnedNpmPackage; 5] = [
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
const MAX_API_REFERENCE_BYTES: usize = 32 * 1024;
const MAX_DEVICES_FILE_BYTES: usize = 1024 * 1024;
const MAX_DEVICES: usize = 256;
const MAX_API_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_SESSION_EXPORT_BYTES: usize = 32 * 1024 * 1024;
const MAX_TEXT_DOWNLOAD_BYTES: usize = 16 * 1024 * 1024;
const MAX_REMOTE_DOWNLOAD_BYTES: usize = 512 * 1024 * 1024;
const MAX_UPLOAD_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES: usize = 256 * 1024 * 1024;
const MAX_UPLOAD_FILES: usize = 64;
const MAX_SSE_BUFFER_BYTES: usize = 1024 * 1024;
const MAX_AUTH_RESPONSE_BYTES: usize = 64 * 1024;
const TAILSCALE_STATUS_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_TAILSCALE_STATUS_BYTES: usize = 4 * 1024 * 1024;
const MAX_DISCOVERED_TAILNET_PEERS: usize = 256;
const MAX_TAILNET_SERVICE_PROBES: usize = 32;
const MAX_TAILNET_PROBE_CONCURRENCY: usize = 8;
const TAILNET_CLIENT_CACHE_CAPACITY: usize = 64;
const TAILNET_CLIENT_CACHE_TTL: Duration = Duration::from_secs(120);
const MAX_CLOCK_OFFSET_SECONDS: i64 = 24 * 60 * 60;
const PIHUB_AUTH_SCHEME: &str = "PiHub-HMAC-SHA256";
const PIHUB_SIGNING_CONTEXT: &str = "pihub-request-v3";
const PIHUB_CONTENT_SHA256_HEADER: &str = "x-pihub-content-sha256";
const PIHUB_DESKTOP_BUNDLE_IDENTIFIER: &str = "io.github.yourchaingod.pihub.desktop";
const LEGACY_DESKTOP_BUNDLE_IDENTIFIER: &str = "dev.pihub.desktop";
const PIHUB_KEYRING_SERVICE: &str = "io.github.yourchaingod.pihub.desktop.auth.v1";
#[cfg(test)]
const LEGACY_DESKTOP_KEYRING_SERVICE: &str = "com.pihub.desktop.auth.v1";
const PIHUB_CREDENTIAL_VERSION: u8 = 1;

const PATH_COMPONENT_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'!')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'\'')
    .add(b'(')
    .add(b')')
    .add(b'*')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticationMetadata {
    scheme: String,
    signing_context: String,
    epoch: String,
    server_time_unix_seconds: i64,
    timestamp_window_seconds: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCredential {
    version: u8,
    origin: String,
    device_id: String,
    secret: String,
    epoch: String,
    clock_offset_seconds: i64,
    timestamp_window_seconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStatus {
    paired: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
}

#[derive(Clone)]
struct AuthenticatedRequestSpec {
    method: reqwest::Method,
    endpoint: url::Url,
    body: Option<Bytes>,
    content_type: Option<String>,
    accept: Option<&'static str>,
    content_sha256: String,
    timeout: Option<Duration>,
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let bits = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(ALPHABET[((bits >> 18) & 63) as usize] as char);
        output.push(ALPHABET[((bits >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[((bits >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(bits & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn device_store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn metadata_is_link_like(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    false
}

#[cfg(windows)]
fn windows_error(context: &str, code: u32) -> String {
    format!(
        "{context}：{}",
        std::io::Error::from_raw_os_error(code as i32)
    )
}

#[cfg(windows)]
fn aligned_windows_buffer(bytes: usize) -> Vec<usize> {
    vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())]
}

#[cfg(windows)]
fn current_windows_user_sid() -> Result<Vec<usize>, String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, HANDLE},
        Security::{GetLengthSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER},
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: Windows initializes `token` on success, and it is closed on every
    // path after OpenProcessToken succeeds.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(windows_error("无法读取当前 Windows 用户令牌", unsafe {
            GetLastError()
        }));
    }

    let result = (|| {
        let mut required = 0u32;
        // The first call intentionally supplies no buffer to obtain its size.
        unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut required) };
        if required == 0 {
            return Err(windows_error("无法确定 Windows 用户 SID 长度", unsafe {
                GetLastError()
            }));
        }
        let mut token_info = aligned_windows_buffer(required as usize);
        if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                token_info.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(windows_error("无法读取 Windows 用户 SID", unsafe {
                GetLastError()
            }));
        }
        let user = unsafe { &*(token_info.as_ptr().cast::<TOKEN_USER>()) };
        if user.User.Sid.is_null() {
            return Err("Windows 用户令牌缺少 SID".into());
        }
        let sid_length = unsafe { GetLengthSid(user.User.Sid) } as usize;
        if sid_length == 0 {
            return Err("Windows 用户 SID 长度无效".into());
        }
        let mut sid = aligned_windows_buffer(sid_length);
        unsafe {
            std::ptr::copy_nonoverlapping(
                user.User.Sid.cast::<u8>(),
                sid.as_mut_ptr().cast::<u8>(),
                sid_length,
            );
        }
        Ok(sid)
    })();
    unsafe {
        CloseHandle(token);
    }
    result
}

#[cfg(windows)]
fn current_user_only_acl(inherit_to_children: bool) -> Result<Vec<usize>, String> {
    use windows_sys::Win32::{
        Foundation::GetLastError,
        Security::{
            AddAccessAllowedAceEx, GetLengthSid, InitializeAcl, ACCESS_ALLOWED_ACE, ACL,
            ACL_REVISION, CONTAINER_INHERIT_ACE, OBJECT_INHERIT_ACE,
        },
        Storage::FileSystem::FILE_ALL_ACCESS,
    };

    let mut sid = current_windows_user_sid()?;
    let sid_pointer = sid.as_mut_ptr().cast();
    let sid_length = unsafe { GetLengthSid(sid_pointer) } as usize;
    let acl_bytes = std::mem::size_of::<ACL>() + std::mem::size_of::<ACCESS_ALLOWED_ACE>()
        - std::mem::size_of::<u32>()
        + sid_length;
    let mut acl = aligned_windows_buffer(acl_bytes);
    let acl_pointer = acl.as_mut_ptr().cast::<ACL>();
    if unsafe { InitializeAcl(acl_pointer, acl_bytes as u32, ACL_REVISION) } == 0 {
        return Err(windows_error("无法初始化 Windows 私有 ACL", unsafe {
            GetLastError()
        }));
    }
    let inheritance = if inherit_to_children {
        OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
    } else {
        0
    };
    if unsafe {
        AddAccessAllowedAceEx(
            acl_pointer,
            ACL_REVISION,
            inheritance,
            FILE_ALL_ACCESS,
            sid_pointer,
        )
    } == 0
    {
        return Err(windows_error("无法写入 Windows 私有 ACL", unsafe {
            GetLastError()
        }));
    }
    Ok(acl)
}

#[cfg(windows)]
fn tighten_private_windows_path(path: &Path, inherit_to_children: bool) -> Result<(), String> {
    use windows_sys::Win32::Security::{
        Authorization::{SetNamedSecurityInfoW, SE_FILE_OBJECT},
        DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    };

    let acl = current_user_only_acl(inherit_to_children)?;
    let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let status = unsafe {
        SetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl.as_ptr().cast(),
            std::ptr::null(),
        )
    };
    if status != 0 {
        return Err(windows_error("无法收紧 Windows 私有路径权限", status));
    }
    Ok(())
}

fn tighten_private_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("无法收紧设备配置目录权限：{error}"))?;
    #[cfg(windows)]
    tighten_private_windows_path(path, true)?;
    Ok(())
}

fn tighten_private_file(file: &fs::File, path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("无法收紧设备清单权限：{error}"))?;
    #[cfg(windows)]
    {
        let _ = file;
        tighten_private_windows_path(path, false)?;
    }
    #[cfg(not(windows))]
    let _ = path;
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or("设备配置目录没有父目录")?;
            fs::create_dir_all(parent).map_err(|error| format!("无法创建配置父目录：{error}"))?;
            match fs::create_dir(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(format!("无法创建设备配置目录：{error}")),
            }
        }
        Err(error) => return Err(format!("无法检查设备配置目录：{error}")),
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("无法读取设备配置目录元数据：{error}"))?;
    if metadata_is_link_like(&metadata) || !metadata.is_dir() {
        return Err("设备配置目录必须是本机普通目录，不能是链接或重解析点".into());
    }
    tighten_private_directory(path)
}

fn devices_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    ensure_private_directory(&dir)?;
    Ok(dir.join("devices.json"))
}

fn validate_device(device: &Device) -> Result<(), String> {
    if device.id.is_empty()
        || device.id.len() > 128
        || !device
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("设备 ID 格式无效".into());
    }
    if device.name.trim() != device.name
        || device.name.is_empty()
        || device.name.len() > 256
        || device.name.chars().any(char::is_control)
    {
        return Err("设备名称为空、过长或包含控制字符".into());
    }
    if !matches!(device.source.as_str(), "tailscale" | "manual") {
        return Err("设备来源无效".into());
    }
    if device.accent.len() != 7
        || !device.accent.starts_with('#')
        || !device.accent[1..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("设备强调色必须是六位十六进制颜色".into());
    }
    if device.os.as_deref().is_some_and(|os| {
        os.trim() != os || os.is_empty() || os.len() > 32 || os.chars().any(char::is_control)
    }) {
        return Err("设备操作系统标识无效".into());
    }
    if device.host.trim() != device.host
        || device.host.is_empty()
        || device.host.len() > 512
        || device.host.chars().any(|character| {
            character.is_control() || matches!(character, '/' | '\\' | '@' | '?' | '#')
        })
    {
        return Err("设备主机显示值无效".into());
    }
    let base = validate_tailnet_url(&device.url)?;
    let host = base.host_str().ok_or("设备地址缺少主机名")?;
    let display_host = base
        .host()
        .map(|value| value.to_string())
        .unwrap_or_else(|| host.to_owned());
    let port = base.port().map(|value| value.to_string());
    let host_matches = device.host.eq_ignore_ascii_case(host)
        || device.host.eq_ignore_ascii_case(&display_host)
        || port.as_ref().is_some_and(|port| {
            device
                .host
                .eq_ignore_ascii_case(&format!("{display_host}:{port}"))
        });
    if !host_matches {
        return Err("设备主机显示值与连接地址不一致".into());
    }
    Ok(())
}

fn validate_device_list(devices: &[Device]) -> Result<(), String> {
    if devices.len() > MAX_DEVICES {
        return Err("设备清单超过 256 台上限".into());
    }
    let mut ids = HashSet::new();
    let mut origins = HashSet::new();
    for device in devices {
        validate_device(device)?;
        if !ids.insert(device.id.clone()) {
            return Err("设备清单包含重复 ID".into());
        }
        let base = validate_tailnet_url(&device.url)?;
        if !origins.insert(canonical_origin(&base)) {
            return Err("设备清单包含重复连接地址".into());
        }
    }
    Ok(())
}

fn open_devices_for_read(path: &Path, tighten_permissions: bool) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    #[cfg(windows)]
    options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    let file = options
        .open(path)
        .map_err(|error| format!("无法打开设备清单：{error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取设备清单元数据：{error}"))?;
    if metadata_is_link_like(&metadata) || !metadata.is_file() {
        return Err("设备清单必须是本机普通文件，不能是链接或重解析点".into());
    }
    if metadata.len() > MAX_DEVICES_FILE_BYTES as u64 {
        return Err("设备清单超过 1MB 上限".into());
    }
    if tighten_permissions {
        tighten_private_file(&file, path)?;
    }
    Ok(file)
}

fn read_devices_file_with_policy(
    path: &Path,
    tighten_permissions: bool,
) -> Result<Vec<Device>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("无法检查设备清单：{error}")),
        Ok(metadata) if metadata_is_link_like(&metadata) || !metadata.is_file() => {
            return Err("设备清单必须是本机普通文件，不能是链接或重解析点".into())
        }
        Ok(_) => {}
    }
    let mut file = open_devices_for_read(path, tighten_permissions)?;
    let mut data = Vec::new();
    Read::by_ref(&mut file)
        .take((MAX_DEVICES_FILE_BYTES + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|error| format!("无法读取设备清单：{error}"))?;
    if data.len() > MAX_DEVICES_FILE_BYTES {
        return Err("设备清单超过 1MB 上限".into());
    }
    let devices = serde_json::from_slice::<Vec<Device>>(&data)
        .map_err(|error| format!("设备清单格式无效：{error}"))?;
    validate_device_list(&devices)?;
    Ok(devices)
}

fn read_devices_file(path: &Path) -> Result<Vec<Device>, String> {
    read_devices_file_with_policy(path, true)
}

fn create_devices_temp(directory: &Path) -> Result<(PathBuf, fs::File), String> {
    for _ in 0..8 {
        let mut random = [0u8; 18];
        getrandom::fill(&mut random).map_err(|_| "无法生成设备清单临时文件名".to_owned())?;
        let path = directory.join(format!(".devices-{}.tmp", URL_SAFE_NO_PAD.encode(random)));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        match options.open(&path) {
            Ok(file) => {
                if let Err(error) = tighten_private_file(&file, &path) {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(error);
                }
                return Ok((path, file));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建设备清单临时文件：{error}")),
        }
    }
    Err("无法分配设备清单临时文件".into())
}

fn write_devices_file(path: &Path, devices: &[Device]) -> Result<(), String> {
    validate_device_list(devices)?;
    let mut data = serde_json::to_vec_pretty(devices).map_err(|error| error.to_string())?;
    data.push(b'\n');
    if data.len() > MAX_DEVICES_FILE_BYTES {
        return Err("设备清单超过 1MB 上限".into());
    }
    let directory = path.parent().ok_or("设备清单没有父目录")?;
    ensure_private_directory(directory)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法检查现有设备清单：{error}")),
        Ok(metadata) if metadata_is_link_like(&metadata) || !metadata.is_file() => {
            return Err("现有设备清单不是本机普通文件".into())
        }
        Ok(_) => {}
    }
    let (temporary_path, mut temporary) = create_devices_temp(directory)?;
    let write_result = temporary
        .write_all(&data)
        .and_then(|_| temporary.sync_all())
        .map_err(|error| format!("无法写入设备清单临时文件：{error}"));
    if let Err(error) = write_result {
        drop(temporary);
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    drop(temporary);
    if let Err(error) = fs::rename(&temporary_path, path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!("无法原子替换设备清单：{error}"));
    }
    #[cfg(unix)]
    fs::File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("无法同步设备配置目录：{error}"))?;
    Ok(())
}

fn read_devices(app: &AppHandle) -> Result<Vec<Device>, String> {
    read_devices_file(&devices_path(app)?)
}

fn write_devices(app: &AppHandle, devices: &[Device]) -> Result<(), String> {
    write_devices_file(&devices_path(app)?, devices)
}

fn legacy_devices_path_from_config_directory(config_directory: &Path) -> Result<PathBuf, String> {
    if config_directory
        .file_name()
        .and_then(|value| value.to_str())
        != Some(PIHUB_DESKTOP_BUNDLE_IDENTIFIER)
    {
        return Err("当前桌面配置目录与 PiHub Desktop 身份不一致".into());
    }
    let parent = config_directory
        .parent()
        .ok_or("当前桌面配置目录没有父目录")?;
    Ok(parent
        .join(LEGACY_DESKTOP_BUNDLE_IDENTIFIER)
        .join("devices.json"))
}

fn read_legacy_devices_file(path: &Path) -> Result<Vec<Device>, String> {
    let directory = path.parent().ok_or("旧版设备清单没有父目录")?;
    match fs::symlink_metadata(directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("未找到旧版 PiHub 设备清单".into())
        }
        Err(error) => return Err(format!("无法检查旧版设备配置目录：{error}")),
        Ok(metadata) if metadata_is_link_like(&metadata) || !metadata.is_dir() => {
            return Err("旧版设备配置目录必须是本机普通目录".into())
        }
        Ok(_) => {}
    }
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("未找到旧版 PiHub 设备清单".into())
        }
        Err(error) => return Err(format!("无法检查旧版设备清单：{error}")),
        Ok(metadata) if metadata_is_link_like(&metadata) || !metadata.is_file() => {
            return Err("旧版设备清单必须是本机普通文件".into())
        }
        Ok(_) => {}
    }
    read_devices_file_with_policy(path, false)
}

fn merge_legacy_devices(
    current: &[Device],
    legacy: Vec<Device>,
) -> Result<(Vec<Device>, usize, usize), String> {
    validate_device_list(current)?;
    validate_device_list(&legacy)?;
    let mut merged = current.to_vec();
    let mut ids: HashSet<String> = current.iter().map(|device| device.id.clone()).collect();
    let mut origins: HashSet<String> = current
        .iter()
        .map(|device| validate_tailnet_url(&device.url).map(|url| canonical_origin(&url)))
        .collect::<Result<_, _>>()?;
    let mut imported = 0;
    let mut skipped = 0;
    for device in legacy {
        let origin = canonical_origin(&validate_tailnet_url(&device.url)?);
        if ids.contains(&device.id) || origins.contains(&origin) {
            skipped += 1;
            continue;
        }
        ids.insert(device.id.clone());
        origins.insert(origin);
        merged.push(device);
        imported += 1;
    }
    validate_device_list(&merged)?;
    Ok((merged, imported, skipped))
}

fn create_legacy_import_backup(path: &Path, devices: &[Device]) -> Result<String, String> {
    let directory = path.parent().ok_or("设备清单没有父目录")?;
    for _ in 0..8 {
        let mut random = [0u8; 12];
        getrandom::fill(&mut random).map_err(|_| "无法生成设备备份文件名".to_owned())?;
        let filename = format!(
            "devices.before-legacy-import-{}.json",
            URL_SAFE_NO_PAD.encode(random)
        );
        let candidate = directory.join(&filename);
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                write_devices_file(&candidate, devices)?;
                return Ok(filename);
            }
            Err(error) => return Err(format!("无法检查设备备份路径：{error}")),
            Ok(_) => continue,
        }
    }
    Err("无法分配设备备份文件名".into())
}

fn import_legacy_device_metadata_paths(
    current_path: &Path,
    legacy_path: &Path,
) -> Result<LegacyDeviceImportResult, String> {
    let current = read_devices_file(current_path)?;
    let legacy = read_legacy_devices_file(legacy_path)?;
    let (devices, imported, skipped) = merge_legacy_devices(&current, legacy)?;
    if imported == 0 {
        return Ok(LegacyDeviceImportResult {
            devices,
            imported,
            skipped,
            backup: None,
            credentials_migrated: false,
        });
    }
    let backup = create_legacy_import_backup(current_path, &current)?;
    write_devices_file(current_path, &devices)?;
    Ok(LegacyDeviceImportResult {
        devices,
        imported,
        skipped,
        backup: Some(backup),
        credentials_migrated: false,
    })
}

fn is_tailscale_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            octets[0] == 100 && (64..=127).contains(&octets[1])
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            segments[0] == 0xfd7a && segments[1] == 0x115c && segments[2] == 0xa1e0
        }
    }
}

fn is_tailscale_host(host: &str) -> bool {
    let normalized = host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if normalized.ends_with(".ts.net") {
        return true;
    }
    normalized.parse::<IpAddr>().is_ok_and(is_tailscale_ip)
}

fn validate_percent_encoding(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return Err("地址包含无效的百分号编码".into());
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    Ok(())
}

fn decode_safe_path_segment(segment: &str) -> Result<String, String> {
    let mut decoded = segment.to_owned();
    for _ in 0..4 {
        if decoded == segment {
            validate_percent_encoding(&decoded)?;
        }
        let next = percent_encoding::percent_decode_str(&decoded)
            .decode_utf8()
            .map_err(|_| "API 路径不是有效的 UTF-8".to_owned())?
            .into_owned();
        if matches!(next.as_str(), "." | "..")
            || next.contains(['/', '\\'])
            || next.chars().any(char::is_control)
        {
            return Err("API 路径包含越界或分隔符编码".into());
        }
        if next == decoded {
            return Ok(next);
        }
        let bytes = next.as_bytes();
        if !(0..bytes.len().saturating_sub(2)).any(|index| {
            bytes[index] == b'%'
                && bytes[index + 1].is_ascii_hexdigit()
                && bytes[index + 2].is_ascii_hexdigit()
        }) {
            return Ok(next);
        }
        decoded = next;
    }
    Err("API 路径编码层级过深".into())
}

fn validate_raw_api_reference(reference: &str) -> Result<(), String> {
    if reference.is_empty() || reference.len() > MAX_API_REFERENCE_BYTES {
        return Err("API 地址为空或过长".into());
    }
    if reference.contains('\\') || reference.chars().any(char::is_control) {
        return Err("API 地址包含非法字符".into());
    }
    validate_percent_encoding(reference)?;
    if reference.contains('#') {
        return Err("API 地址不允许包含片段".into());
    }
    let raw_path = reference
        .split_once('?')
        .map_or(reference, |(path, _)| path);
    if !raw_path.starts_with('/') || raw_path.starts_with("//") {
        return Err("API 地址必须是站点内的绝对路径".into());
    }
    let components: Vec<&str> = raw_path.split('/').collect();
    for (index, component) in components.iter().enumerate().skip(1) {
        if component.is_empty() {
            if index + 1 != components.len() {
                return Err("API 路径不允许包含空段".into());
            }
            continue;
        }
        decode_safe_path_segment(component)?;
    }
    Ok(())
}

fn strict_form_component(value: &str) -> Result<String, String> {
    validate_percent_encoding(value)?;
    let form_value = value.replace('+', " ");
    let decoded = percent_encoding::percent_decode_str(&form_value)
        .decode_utf8()
        .map_err(|_| "API 查询参数不是有效的 UTF-8".to_owned())?
        .into_owned();
    if decoded.len() > MAX_API_REFERENCE_BYTES || decoded.chars().any(char::is_control) {
        return Err("API 查询参数包含非法字符或过长".into());
    }
    Ok(decoded)
}

fn strict_query(endpoint: &url::Url) -> Result<HashMap<String, String>, String> {
    let mut query = HashMap::new();
    let Some(raw_query) = endpoint.query() else {
        return Ok(query);
    };
    if raw_query.is_empty() {
        return Err("API 查询参数不能为空".into());
    }
    for pair in raw_query.split('&') {
        if pair.is_empty() {
            return Err("API 查询参数格式无效".into());
        }
        let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = strict_form_component(raw_key)?;
        let value = strict_form_component(raw_value)?;
        if key.is_empty() || query.insert(key, value).is_some() {
            return Err("API 查询参数为空或重复".into());
        }
    }
    Ok(query)
}

fn validate_query_shape(
    query: &HashMap<String, String>,
    allowed: &[&str],
    required: &[&str],
) -> Result<(), String> {
    if query.keys().any(|key| !allowed.contains(&key.as_str()))
        || required.iter().any(|key| !query.contains_key(*key))
    {
        return Err("API 查询参数不在允许列表中".into());
    }
    Ok(())
}

fn decoded_api_segments(endpoint: &url::Url) -> Result<Vec<String>, String> {
    endpoint
        .path_segments()
        .ok_or_else(|| "API 地址没有分层路径".to_owned())?
        .map(decode_safe_path_segment)
        .collect()
}

fn validate_generic_api_route(endpoint: &url::Url, method: &str) -> Result<(), String> {
    if !matches!(method, "GET" | "POST" | "PATCH" | "PUT" | "DELETE") {
        return Err("不支持的请求方法".into());
    }
    let segments = decoded_api_segments(endpoint)?;
    let path: Vec<&str> = segments.iter().map(String::as_str).collect();
    let query = strict_query(endpoint)?;
    let no_query = |query: &HashMap<String, String>| validate_query_shape(query, &[], &[]);

    match path.as_slice() {
        ["api", "sessions"] if method == "GET" => no_query(&query),
        ["api", "sessions", _] if method == "GET" => {
            validate_query_shape(
                &query,
                &["deferThinking", "deferMedia", "desktop", "limit"],
                &[],
            )?;
            for key in ["deferThinking", "deferMedia", "desktop"] {
                if query
                    .get(key)
                    .is_some_and(|value| value != "0" && value != "1")
                {
                    return Err("会话查询开关必须为 0 或 1".into());
                }
            }
            if query.get("limit").is_some_and(|value| {
                value
                    .parse::<u16>()
                    .map_or(true, |limit| limit == 0 || limit > 500)
            }) {
                return Err("会话查询数量超出允许范围".into());
            }
            Ok(())
        }
        ["api", "sessions", _] if matches!(method, "PATCH" | "DELETE") => no_query(&query),
        ["api", "sessions", _, "auto-name"] if method == "POST" => no_query(&query),
        ["api", "sessions", _, "entries", _, "thinking"] if method == "GET" => {
            validate_query_shape(&query, &["blockIndex"], &["blockIndex"])?;
            if query["blockIndex"].parse::<u32>().is_err() {
                return Err("思考块索引无效".into());
            }
            Ok(())
        }
        ["api", "agent", "running"] if method == "GET" => no_query(&query),
        ["api", "agent", "new"] if method == "POST" => no_query(&query),
        ["api", "agent", _] if matches!(method, "GET" | "POST") => no_query(&query),
        ["api", "models"] if method == "GET" => validate_query_shape(&query, &["cwd"], &["cwd"]),
        ["api", "models-config"] if matches!(method, "GET" | "PUT") => no_query(&query),
        ["api", "pihub", "newapi"] if matches!(method, "GET" | "POST") => no_query(&query),
        ["api", "pihub", "files"] if method == "POST" => no_query(&query),
        ["api", "pihub", "terminal"] if method == "POST" => no_query(&query),
        ["api", "pihub", "terminal"] if method == "GET" => {
            validate_query_shape(&query, &["id", "offset"], &["id", "offset"])?;
            if query["id"].is_empty() || query["offset"].parse::<u64>().is_err() {
                return Err("终端查询参数无效".into());
            }
            Ok(())
        }
        ["api", "pihub", "setup"] if matches!(method, "GET" | "POST") => no_query(&query),
        ["api", "pihub", "updates"] if method == "GET" => {
            validate_query_shape(&query, &["cwd"], &[])
        }
        ["api", "pihub", "updates"] if method == "POST" => no_query(&query),
        ["api", "file-index"] if method == "GET" => {
            validate_query_shape(&query, &["cwd"], &["cwd"])
        }
        ["api", "git", "status"] if method == "GET" => {
            validate_query_shape(&query, &["cwd"], &["cwd"])
        }
        ["api", "cwd", "browse"] if method == "GET" => validate_query_shape(&query, &["path"], &[]),
        ["api", "cwd", "validate"] if method == "POST" => no_query(&query),
        ["api", "files", rest @ ..] if !rest.is_empty() && method == "GET" => {
            validate_query_shape(&query, &["type", "sessionId"], &["type", "sessionId"])?;
            if !matches!(query["type"].as_str(), "read" | "list") || query["sessionId"].is_empty() {
                return Err("文件读取参数无效".into());
            }
            Ok(())
        }
        ["api", "files", rest @ ..] if !rest.is_empty() && method == "POST" => {
            validate_query_shape(&query, &["type"], &["type"])?;
            if query["type"] != "upload-check" {
                return Err("文件操作不在允许列表中".into());
            }
            Ok(())
        }
        _ => Err("API 路由或请求方法不在桌面端允许列表中".into()),
    }
}

#[derive(Clone, Copy)]
enum ApiAccess<'a> {
    Generic { method: &'a str },
    FileDownload,
    FileUpload,
    SessionExport,
    AgentStream,
}

fn validate_file_api_route(endpoint: &url::Url, upload: bool) -> Result<(), String> {
    let segments = decoded_api_segments(endpoint)?;
    let path: Vec<&str> = segments.iter().map(String::as_str).collect();
    if !matches!(path.as_slice(), ["api", "files", rest @ ..] if !rest.is_empty()) {
        return Err("文件地址必须保持在 /api/files 下".into());
    }
    let query = strict_query(endpoint)?;
    if upload {
        validate_query_shape(&query, &["type", "conflict"], &["type", "conflict"])?;
        if query["type"] != "upload"
            || !matches!(query["conflict"].as_str(), "error" | "overwrite" | "skip")
        {
            return Err("文件上传参数无效".into());
        }
    } else {
        validate_query_shape(&query, &["type", "sessionId"], &["type", "sessionId"])?;
        if query["type"] != "download" || query["sessionId"].is_empty() {
            return Err("文件下载参数无效".into());
        }
    }
    Ok(())
}

fn validated_api_endpoint(
    base: &url::Url,
    reference: &str,
    access: ApiAccess<'_>,
) -> Result<url::Url, String> {
    validate_raw_api_reference(reference)?;
    let endpoint = base
        .join(reference)
        .map_err(|error| format!("API 地址无效：{error}"))?;
    if endpoint.origin() != base.origin()
        || endpoint.scheme() != "https"
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
    {
        return Err("API 地址越界或包含身份信息".into());
    }
    match access {
        ApiAccess::Generic { method } => validate_generic_api_route(&endpoint, method)?,
        ApiAccess::FileDownload => validate_file_api_route(&endpoint, false)?,
        ApiAccess::FileUpload => validate_file_api_route(&endpoint, true)?,
        ApiAccess::SessionExport => {
            let segments = decoded_api_segments(&endpoint)?;
            if !matches!(segments.iter().map(String::as_str).collect::<Vec<_>>().as_slice(), ["api", "sessions", id, "export"] if !id.is_empty())
                || !strict_query(&endpoint)?.is_empty()
            {
                return Err("会话导出地址无效".into());
            }
        }
        ApiAccess::AgentStream => {
            let segments = decoded_api_segments(&endpoint)?;
            if !matches!(segments.iter().map(String::as_str).collect::<Vec<_>>().as_slice(), ["api", "agent", id, "events"] if !id.is_empty())
                || !strict_query(&endpoint)?.is_empty()
            {
                return Err("实时会话地址无效".into());
            }
        }
    }
    Ok(endpoint)
}

fn validate_tailnet_url(value: &str) -> Result<url::Url, String> {
    if value.trim() != value
        || value.len() > 2048
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err("设备地址包含非法字符或过长".into());
    }
    validate_percent_encoding(value)?;
    let parsed = url::Url::parse(value).map_err(|error| error.to_string())?;
    if parsed.scheme() != "https" {
        return Err("PiHub 只允许通过 Tailscale Serve 的 HTTPS 连接".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("设备地址不允许包含用户名或密码".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() || parsed.path() != "/" {
        return Err("设备地址只能包含 HTTPS 源站，不允许附带路径、查询或片段".into());
    }
    let scheme_end = value.find("://").ok_or("设备地址缺少 HTTPS 协议")?;
    let authority_and_suffix = &value[scheme_end + 3..];
    let suffix = authority_and_suffix
        .find(['/', '?', '#'])
        .map_or("", |index| &authority_and_suffix[index..]);
    if !matches!(suffix, "" | "/") {
        return Err("设备地址只能使用根路径".into());
    }
    let host = parsed.host_str().ok_or("设备地址缺少主机名")?;
    if !is_tailscale_host(host) {
        return Err("只允许 Tailscale IP 或 MagicDNS (.ts.net) 地址".into());
    }
    Ok(parsed)
}

async fn tailscale_status() -> Result<Value, String> {
    let executable = tailscale_command().ok_or("未找到 Tailscale 客户端")?;
    let output = bootstrap::run_bounded_command(
        bootstrap::BoundedCommand {
            executable,
            args: vec!["status".into(), "--json".into()],
            current_dir: None,
            stdin: bootstrap::BootstrapStdin::Raw(Vec::new()),
        },
        bootstrap::ProcessLimits {
            total_timeout: TAILSCALE_STATUS_TIMEOUT,
            capture_bytes_per_stream: MAX_TAILSCALE_STATUS_BYTES,
            log_line_bytes: 1,
            log_lines_per_stream: 1,
        },
        |_| {},
    )
    .await
    .map_err(|_| "tailscale status 启动失败或超过 8 秒时限".to_owned())?;
    if output.stdout_truncated || output.stderr_truncated {
        return Err("tailscale status 输出超过 4 MiB 安全上限".into());
    }
    if !output.status.success() {
        return Err(format!(
            "无法读取 Tailscale 状态（退出状态 {}）",
            output.status
        ));
    }
    if output.stdout.iter().all(u8::is_ascii_whitespace) {
        return Err("tailscale status 返回空输出（Tailscale 可能未登录）".into());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "tailscale status 输出不是有效 JSON".to_owned())
}

fn tailnet_ip_from_status(status: &Value, hostname: &str) -> Option<IpAddr> {
    let wanted = hostname.trim_end_matches('.').to_ascii_lowercase();
    let matching_ip = |node: &Value| {
        let dns = node
            .get("DNSName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_end_matches('.')
            .to_ascii_lowercase();
        if dns != wanted {
            return None;
        }
        node.get("TailscaleIPs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(|value| value.parse::<IpAddr>().ok())
            .filter(|ip| is_tailscale_ip(*ip))
            .find(IpAddr::is_ipv4)
            .or_else(|| {
                node.get("TailscaleIPs")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter_map(|value| value.parse::<IpAddr>().ok())
                    .find(|ip| is_tailscale_ip(*ip))
            })
    };
    if let Some(ip) = status.get("Self").and_then(matching_ip) {
        return Some(ip);
    }
    if let Some(peers) = status.get("Peer").and_then(Value::as_object) {
        return peers.values().find_map(matching_ip);
    }
    None
}

async fn tailnet_ip_for_hostname(hostname: &str) -> Result<Option<IpAddr>, String> {
    let wanted = hostname.trim_end_matches('.').to_ascii_lowercase();
    if let Ok(ip) = wanted.parse::<IpAddr>() {
        return Ok(is_tailscale_ip(ip).then_some(ip));
    }
    if !wanted.ends_with(".ts.net") {
        return Ok(None);
    }
    Ok(tailnet_ip_from_status(&tailscale_status().await?, &wanted))
}

fn tailnet_cache_key(base: &url::Url) -> String {
    format!(
        "{}://{}:{}",
        base.scheme(),
        base.host_str().unwrap_or_default(),
        base.port_or_known_default().unwrap_or(443)
    )
}

#[derive(Clone)]
struct TailnetClientCacheEntry {
    client: reqwest::Client,
    created_at: Instant,
    last_used_at: Instant,
}

#[derive(Default)]
struct TailnetClientCache {
    entries: HashMap<String, TailnetClientCacheEntry>,
}

impl TailnetClientCache {
    fn prune_expired(&mut self, now: Instant) {
        self.entries.retain(|_, entry| {
            now.saturating_duration_since(entry.created_at) < TAILNET_CLIENT_CACHE_TTL
        });
    }

    fn get(&mut self, key: &str, now: Instant) -> Option<reqwest::Client> {
        self.prune_expired(now);
        let entry = self.entries.get_mut(key)?;
        entry.last_used_at = now;
        Some(entry.client.clone())
    }

    fn insert(&mut self, key: String, client: reqwest::Client, now: Instant) {
        self.prune_expired(now);
        if !self.entries.contains_key(&key) && self.entries.len() >= TAILNET_CLIENT_CACHE_CAPACITY {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used_at)
                .map(|(key, _)| key.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(
            key,
            TailnetClientCacheEntry {
                client,
                created_at: now,
                last_used_at: now,
            },
        );
    }
}

fn tailnet_clients() -> &'static Mutex<TailnetClientCache> {
    static CLIENTS: OnceLock<Mutex<TailnetClientCache>> = OnceLock::new();
    CLIENTS.get_or_init(|| Mutex::new(TailnetClientCache::default()))
}

/// Drop the cached client for an origin so the next request re-resolves the
/// MagicDNS name via `tailscale status` — Tailscale IPs can change when a
/// device rejoins or switches networks, and a pinned stale IP otherwise
/// breaks the device until the app restarts.
fn invalidate_tailnet_client(base: &url::Url) {
    if let Ok(mut clients) = tailnet_clients().lock() {
        clients.entries.remove(&tailnet_cache_key(base));
    }
}

/// Shared, per-origin cached client: connection-pooled, proxy-free, TCP
/// keepalive for DERP relay hops, MagicDNS pinned to the current Tailscale
/// IP. No total-request timeout here — SSE streams must stay open
/// indefinitely, so callers apply their own per-request timeout instead.
fn cached_tailnet_http_client(base: &url::Url) -> Result<Option<reqwest::Client>, String> {
    let cache_key = tailnet_cache_key(base);
    let client = tailnet_clients()
        .lock()
        .map_err(|_| "Tailnet HTTP 客户端缓存不可用")?
        .get(&cache_key, Instant::now());
    Ok(client)
}

fn build_tailnet_http_client(
    base: &url::Url,
    verified_ip: Option<IpAddr>,
) -> Result<reqwest::Client, String> {
    if let Some(client) = cached_tailnet_http_client(base)? {
        return Ok(client);
    }
    let cache_key = tailnet_cache_key(base);
    let host = base.host_str().ok_or("设备地址缺少主机名")?;
    // Tailnet traffic must never go through the user's HTTP(S) proxy. A
    // corporate or local proxy cannot resolve MagicDNS and makes healthy
    // Serve endpoints appear offline.
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .pool_idle_timeout(std::time::Duration::from_secs(300))
        .pool_max_idle_per_host(8)
        // DERP relay hops can idle-drop TCP without an RST; keepalives let
        // long-lived SSE streams detect a dead path instead of hanging.
        .tcp_keepalive(std::time::Duration::from_secs(30));
    if host
        .trim_end_matches('.')
        .to_ascii_lowercase()
        .ends_with(".ts.net")
    {
        let ip = verified_ip
            .filter(|ip| is_tailscale_ip(*ip))
            .ok_or("MagicDNS 节点不在当前 Tailnet 状态中，已拒绝 DNS 回退")?;
        builder = builder.resolve(
            host,
            SocketAddr::new(ip, base.port_or_known_default().unwrap_or(443)),
        );
    }
    let client = builder.build().map_err(|error| error.to_string())?;
    tailnet_clients()
        .lock()
        .map_err(|_| "Tailnet HTTP 客户端缓存不可用")?
        .insert(cache_key, client.clone(), Instant::now());
    Ok(client)
}

async fn tailnet_http_client(base: &url::Url) -> Result<reqwest::Client, String> {
    if let Some(client) = cached_tailnet_http_client(base)? {
        return Ok(client);
    }
    let host = base.host_str().ok_or("设备地址缺少主机名")?;
    let verified_ip = if host
        .trim_end_matches('.')
        .to_ascii_lowercase()
        .ends_with(".ts.net")
    {
        Some(
            tailnet_ip_for_hostname(host)
                .await?
                .ok_or("MagicDNS 节点不在当前 Tailnet 状态中，已拒绝连接")?,
        )
    } else {
        None
    };
    build_tailnet_http_client(base, verified_ip)
}

fn canonical_origin(base: &url::Url) -> String {
    base.origin().ascii_serialization()
}

fn is_base64url(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn validate_credential(credential: &StoredCredential, expected_origin: &str) -> Result<(), String> {
    if credential.version != PIHUB_CREDENTIAL_VERSION
        || credential.origin != expected_origin
        || !credential.device_id.starts_with("dev_")
        || !is_base64url(&credential.device_id[4..], 22)
        || !credential.secret.starts_with("pihub_key_")
        || !is_base64url(&credential.secret[10..], 43)
        || !is_base64url(&credential.epoch, 22)
        || credential.clock_offset_seconds.unsigned_abs() > MAX_CLOCK_OFFSET_SECONDS as u64
        || !(1..=600).contains(&credential.timestamp_window_seconds)
    {
        return Err("系统凭据中的 PiHub 设备记录无效，请重新配对".into());
    }
    Ok(())
}

fn credential_username(origin: &str) -> String {
    format!("origin-{}", hex::encode(Sha256::digest(origin.as_bytes())))
}

fn credential_cache() -> &'static Mutex<HashMap<String, StoredCredential>> {
    static CACHE: OnceLock<Mutex<HashMap<String, StoredCredential>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn credential_store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn load_credential_from_keyring(origin: &str) -> Result<Option<StoredCredential>, String> {
    let _guard = credential_store_lock()
        .lock()
        .map_err(|_| "系统凭据存储暂时不可用")?;
    let entry = keyring::Entry::new(PIHUB_KEYRING_SERVICE, &credential_username(origin))
        .map_err(|_| "无法访问系统凭据存储")?;
    let serialized = match entry.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(_) => return Err("无法读取系统凭据，请检查系统钥匙串或凭据管理器".into()),
    };
    let credential = serde_json::from_str::<StoredCredential>(&serialized)
        .map_err(|_| "系统凭据中的 PiHub 设备记录无效，请重新配对".to_owned())?;
    validate_credential(&credential, origin)?;
    Ok(Some(credential))
}

async fn load_credential(base: &url::Url) -> Result<Option<StoredCredential>, String> {
    let origin = canonical_origin(base);
    if let Some(credential) = credential_cache()
        .lock()
        .map_err(|_| "设备凭据缓存暂时不可用")?
        .get(&origin)
        .cloned()
    {
        return Ok(Some(credential));
    }
    let lookup_origin = origin.clone();
    let credential =
        tokio::task::spawn_blocking(move || load_credential_from_keyring(&lookup_origin))
            .await
            .map_err(|_| "系统凭据读取任务异常结束".to_owned())??;
    if let Some(credential) = &credential {
        credential_cache()
            .lock()
            .map_err(|_| "设备凭据缓存暂时不可用")?
            .insert(origin, credential.clone());
    }
    Ok(credential)
}

fn store_credential_in_keyring(credential: &StoredCredential) -> Result<(), String> {
    validate_credential(credential, &credential.origin)?;
    let serialized =
        serde_json::to_string(credential).map_err(|_| "无法编码设备凭据".to_owned())?;
    let _guard = credential_store_lock()
        .lock()
        .map_err(|_| "系统凭据存储暂时不可用")?;
    let entry = keyring::Entry::new(
        PIHUB_KEYRING_SERVICE,
        &credential_username(&credential.origin),
    )
    .map_err(|_| "无法访问系统凭据存储")?;
    entry
        .set_password(&serialized)
        .map_err(|_| "无法将设备密钥写入系统钥匙串或凭据管理器".to_owned())
}

async fn store_credential(credential: StoredCredential) -> Result<(), String> {
    let pending = credential.clone();
    tokio::task::spawn_blocking(move || store_credential_in_keyring(&pending))
        .await
        .map_err(|_| "系统凭据写入任务异常结束".to_owned())??;
    credential_cache()
        .lock()
        .map_err(|_| "设备凭据缓存暂时不可用")?
        .insert(credential.origin.clone(), credential);
    Ok(())
}

fn delete_credential_from_keyring(origin: &str) -> Result<(), String> {
    let _guard = credential_store_lock()
        .lock()
        .map_err(|_| "系统凭据存储暂时不可用")?;
    let entry = keyring::Entry::new(PIHUB_KEYRING_SERVICE, &credential_username(origin))
        .map_err(|_| "无法访问系统凭据存储")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法从系统钥匙串或凭据管理器删除设备凭据".into()),
    }
}

async fn delete_credential(base: &url::Url) -> Result<(), String> {
    let origin = canonical_origin(base);
    let delete_origin = origin.clone();
    tokio::task::spawn_blocking(move || delete_credential_from_keyring(&delete_origin))
        .await
        .map_err(|_| "系统凭据删除任务异常结束".to_owned())??;
    credential_cache()
        .lock()
        .map_err(|_| "设备凭据缓存暂时不可用")?
        .remove(&origin);
    Ok(())
}

fn local_unix_seconds() -> Result<i64, String> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间早于 Unix 纪元，无法安全签名请求".to_owned())?
        .as_secs();
    i64::try_from(seconds).map_err(|_| "系统时间超出签名范围".to_owned())
}

fn validate_authentication_metadata(
    metadata: &AuthenticationMetadata,
    local_sent: i64,
    local_received: i64,
) -> Result<i64, String> {
    if metadata.scheme != PIHUB_AUTH_SCHEME
        || metadata.signing_context != PIHUB_SIGNING_CONTEXT
        || !is_base64url(&metadata.epoch, 22)
        || metadata.server_time_unix_seconds < 0
        || !(1..=600).contains(&metadata.timestamp_window_seconds)
        || local_received < local_sent
        || local_received - local_sent > 30
    {
        return Err("服务端返回了无效或不兼容的鉴权元数据".into());
    }
    let midpoint = local_sent + (local_received - local_sent) / 2;
    let offset = metadata
        .server_time_unix_seconds
        .checked_sub(midpoint)
        .ok_or_else(|| "服务端时间偏移超出范围".to_owned())?;
    if offset.unsigned_abs() > MAX_CLOCK_OFFSET_SECONDS as u64 {
        return Err("设备与本机时间偏差超过 24 小时，请先校准系统时钟".into());
    }
    Ok(offset)
}

fn canonical_request_target(endpoint: &url::Url) -> Result<String, String> {
    if !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
    {
        return Err("签名请求地址包含无效的身份信息或片段".into());
    }
    let path = endpoint
        .path()
        .split('/')
        .map(|segment| {
            let decoded = percent_encoding::percent_decode_str(segment)
                .decode_utf8()
                .map_err(|_| "签名请求路径不是有效的 UTF-8".to_owned())?;
            Ok(
                percent_encoding::utf8_percent_encode(&decoded, PATH_COMPONENT_ENCODE_SET)
                    .to_string(),
            )
        })
        .collect::<Result<Vec<_>, String>>()?
        .join("/");
    let mut pairs = endpoint
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    pairs.sort_by(|left, right| left.0.encode_utf16().cmp(right.0.encode_utf16()));
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        serializer.append_pair(&key, &value);
    }
    let query = serializer.finish();
    if query.is_empty() {
        Ok(if path.is_empty() { "/".into() } else { path })
    } else {
        Ok(format!(
            "{}?{query}",
            if path.is_empty() { "/" } else { &path }
        ))
    }
}

fn signing_payload(
    method: &reqwest::Method,
    endpoint: &url::Url,
    content_sha256: &str,
    timestamp: i64,
    nonce: &str,
    credential: &StoredCredential,
) -> Result<String, String> {
    Ok([
        PIHUB_SIGNING_CONTEXT.to_owned(),
        method.as_str().to_ascii_uppercase(),
        canonical_request_target(endpoint)?,
        content_sha256.to_owned(),
        timestamp.to_string(),
        nonce.to_owned(),
        credential.epoch.clone(),
        credential.device_id.clone(),
    ]
    .join("\n"))
}

fn authorization_value(
    spec: &AuthenticatedRequestSpec,
    credential: &StoredCredential,
    timestamp: i64,
    nonce: &str,
) -> Result<String, String> {
    let payload = signing_payload(
        &spec.method,
        &spec.endpoint,
        &spec.content_sha256,
        timestamp,
        nonce,
        credential,
    )?;
    let mut mac = Hmac::<Sha256>::new_from_slice(credential.secret.as_bytes())
        .map_err(|_| "无法初始化请求签名".to_owned())?;
    mac.update(payload.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!(
        "{PIHUB_AUTH_SCHEME} {}:{timestamp}:{nonce}:{}:{signature}",
        credential.device_id, credential.epoch
    ))
}

fn authorization_header(
    spec: &AuthenticatedRequestSpec,
    credential: &StoredCredential,
) -> Result<reqwest::header::HeaderValue, String> {
    let timestamp = local_unix_seconds()?
        .checked_add(credential.clock_offset_seconds)
        .filter(|timestamp| *timestamp >= 0)
        .ok_or_else(|| "校准后的签名时间超出范围".to_owned())?;
    let mut nonce_bytes = [0u8; 18];
    getrandom::fill(&mut nonce_bytes).map_err(|_| "无法生成安全请求随机数".to_owned())?;
    let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
    let value = authorization_value(spec, credential, timestamp, &nonce)?;
    let mut header = reqwest::header::HeaderValue::from_str(&value)
        .map_err(|_| "无法构造请求鉴权头".to_owned())?;
    header.set_sensitive(true);
    Ok(header)
}

impl AuthenticatedRequestSpec {
    fn empty(method: reqwest::Method, endpoint: url::Url, timeout: Duration) -> Self {
        Self {
            method,
            endpoint,
            body: None,
            content_type: None,
            accept: None,
            content_sha256: hex::encode(Sha256::digest([])),
            timeout: Some(timeout),
        }
    }

    fn json(
        method: reqwest::Method,
        endpoint: url::Url,
        value: &Value,
        timeout: Duration,
    ) -> Result<Self, String> {
        let body =
            Bytes::from(serde_json::to_vec(value).map_err(|_| "无法编码远端请求内容".to_owned())?);
        Ok(Self {
            method,
            endpoint,
            content_sha256: hex::encode(Sha256::digest(&body)),
            body: Some(body),
            content_type: Some("application/json".into()),
            accept: None,
            timeout: Some(timeout),
        })
    }

    fn bytes(
        method: reqwest::Method,
        endpoint: url::Url,
        body: Bytes,
        content_type: String,
        timeout: Duration,
    ) -> Self {
        let content_sha256 = hex::encode(Sha256::digest(&body));
        Self {
            method,
            endpoint,
            body: Some(body),
            content_type: Some(content_type),
            accept: None,
            content_sha256,
            timeout: Some(timeout),
        }
    }

    fn accepting(mut self, value: &'static str) -> Self {
        self.accept = Some(value);
        self
    }

    fn without_timeout(mut self) -> Self {
        self.timeout = None;
        self
    }
}

fn authenticated_request(
    client: &reqwest::Client,
    spec: &AuthenticatedRequestSpec,
    credential: &StoredCredential,
) -> Result<reqwest::RequestBuilder, String> {
    let mut request = client
        .request(spec.method.clone(), spec.endpoint.clone())
        .header(
            reqwest::header::AUTHORIZATION,
            authorization_header(spec, credential)?,
        );
    if let Some(timeout) = spec.timeout {
        request = request.timeout(timeout);
    }
    if let Some(content_type) = &spec.content_type {
        request = request.header(reqwest::header::CONTENT_TYPE, content_type);
    }
    if let Some(accept) = spec.accept {
        request = request.header(reqwest::header::ACCEPT, accept);
    }
    if !matches!(spec.method, reqwest::Method::GET | reqwest::Method::HEAD) {
        request = request.header(PIHUB_CONTENT_SHA256_HEADER, &spec.content_sha256);
    }
    if let Some(body) = &spec.body {
        request = request.body(body.clone());
    }
    Ok(request)
}

fn plain_request(
    client: &reqwest::Client,
    spec: &AuthenticatedRequestSpec,
) -> reqwest::RequestBuilder {
    let mut request = client.request(spec.method.clone(), spec.endpoint.clone());
    if let Some(timeout) = spec.timeout {
        request = request.timeout(timeout);
    }
    if let Some(content_type) = &spec.content_type {
        request = request.header(reqwest::header::CONTENT_TYPE, content_type);
    }
    if let Some(accept) = spec.accept {
        request = request.header(reqwest::header::ACCEPT, accept);
    }
    if let Some(body) = &spec.body {
        request = request.body(body.clone());
    }
    request
}

async fn send_plain(
    base: &url::Url,
    spec: &AuthenticatedRequestSpec,
) -> Result<reqwest::Response, String> {
    let client = tailnet_http_client(base).await?;
    match plain_request(&client, spec).send().await {
        Ok(response) => Ok(response),
        Err(error) if error.is_connect() => {
            invalidate_tailnet_client(base);
            let retry_client = tailnet_http_client(base).await?;
            plain_request(&retry_client, spec)
                .send()
                .await
                .map_err(|error| request_error_text(&error))
        }
        Err(error) => Err(request_error_text(&error)),
    }
}

async fn response_bytes_limited(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<(reqwest::StatusCode, Vec<u8>), String> {
    response_bytes_limited_named(response, max_bytes, "服务端鉴权响应").await
}

async fn response_bytes_limited_named(
    mut response: reqwest::Response,
    max_bytes: usize,
    label: &str,
) -> Result<(reqwest::StatusCode, Vec<u8>), String> {
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(format!("{label}超过大小上限"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| request_error_text(&error))?
    {
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!("{label}超过大小上限"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok((status, body))
}

#[derive(Deserialize)]
struct HealthResponse {
    status: String,
    authentication: AuthenticationMetadata,
}

async fn fetch_authentication_metadata(
    base: &url::Url,
) -> Result<(AuthenticationMetadata, i64), String> {
    let endpoint = base
        .join("/api/health")
        .map_err(|_| "设备健康检查地址无效".to_owned())?;
    let spec =
        AuthenticatedRequestSpec::empty(reqwest::Method::GET, endpoint, Duration::from_secs(12))
            .accepting("application/json");
    let local_sent = local_unix_seconds()?;
    let response = send_plain(base, &spec).await?;
    let local_received = local_unix_seconds()?;
    let (status, body) = response_bytes_limited(response, MAX_AUTH_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(format!("设备健康检查返回 HTTP {status}"));
    }
    let health = serde_json::from_slice::<HealthResponse>(&body)
        .map_err(|_| "设备健康检查响应不是有效的 PiHub JSON".to_owned())?;
    if health.status != "ok" {
        return Err("设备健康检查未返回正常状态".into());
    }
    let offset =
        validate_authentication_metadata(&health.authentication, local_sent, local_received)?;
    Ok((health.authentication, offset))
}

async fn send_authenticated_attempt(
    base: &url::Url,
    spec: &AuthenticatedRequestSpec,
    credential: &StoredCredential,
) -> Result<reqwest::Response, String> {
    let client = tailnet_http_client(base).await?;
    match authenticated_request(&client, spec, credential)?
        .send()
        .await
    {
        Ok(response) => Ok(response),
        Err(error) if error.is_connect() => {
            invalidate_tailnet_client(base);
            let retry_client = tailnet_http_client(base).await?;
            authenticated_request(&retry_client, spec, credential)?
                .send()
                .await
                .map_err(|error| request_error_text(&error))
        }
        Err(error) => Err(request_error_text(&error)),
    }
}

async fn send_authenticated(
    base: &url::Url,
    spec: &AuthenticatedRequestSpec,
) -> Result<reqwest::Response, String> {
    let mut credential = load_credential(base)
        .await?
        .ok_or_else(|| "PIHUB_AUTH_REQUIRED: 此设备尚未与 PiHub 配对".to_owned())?;
    let response = send_authenticated_attempt(base, spec, &credential).await?;
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("PIHUB_AUTH_FORBIDDEN: 当前设备凭据没有执行此操作的权限".into());
    }
    if response.status() != reqwest::StatusCode::UNAUTHORIZED {
        return Ok(response);
    }

    let (metadata, offset) = fetch_authentication_metadata(base).await?;
    credential.epoch = metadata.epoch;
    credential.clock_offset_seconds = offset;
    credential.timestamp_window_seconds = metadata.timestamp_window_seconds;
    store_credential(credential.clone()).await?;

    let response = send_authenticated_attempt(base, spec, &credential).await?;
    match response.status() {
        reqwest::StatusCode::UNAUTHORIZED => {
            Err("PIHUB_AUTH_REQUIRED: 设备凭据已失效或被撤销，请重新配对".into())
        }
        reqwest::StatusCode::FORBIDDEN => {
            Err("PIHUB_AUTH_FORBIDDEN: 当前设备凭据没有执行此操作的权限".into())
        }
        _ => Ok(response),
    }
}

#[derive(Deserialize)]
struct PairingClaimDevice {
    id: String,
    secret: String,
}

#[derive(Deserialize)]
struct PairingClaimResponse {
    device: PairingClaimDevice,
    authentication: AuthenticationMetadata,
}

#[tauri::command]
async fn pair_device(url: String, code: String) -> Result<CredentialStatus, String> {
    let base = validate_tailnet_url(&url)?;
    if !code.starts_with("pihub-") || !is_base64url(&code[6..], 43) {
        return Err("配对码格式无效".into());
    }
    let endpoint = base
        .join("/api/pairing/claim")
        .map_err(|_| "设备配对地址无效".to_owned())?;
    let claim = serde_json::json!({ "code": code });
    let spec = AuthenticatedRequestSpec::json(
        reqwest::Method::POST,
        endpoint,
        &claim,
        Duration::from_secs(15),
    )?
    .accepting("application/json");
    let local_sent = local_unix_seconds()?;
    let response = send_plain(&base, &spec).await?;
    let local_received = local_unix_seconds()?;
    let (status, body) = response_bytes_limited(response, MAX_AUTH_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(match status {
            reqwest::StatusCode::UNAUTHORIZED => "配对码无效或已使用".into(),
            reqwest::StatusCode::TOO_MANY_REQUESTS => "配对尝试过多，请稍后再试".into(),
            _ => format!("设备配对失败：HTTP {status}"),
        });
    }
    let claim = serde_json::from_slice::<PairingClaimResponse>(&body)
        .map_err(|_| "设备配对响应格式无效".to_owned())?;
    let offset =
        validate_authentication_metadata(&claim.authentication, local_sent, local_received)?;
    let credential = StoredCredential {
        version: PIHUB_CREDENTIAL_VERSION,
        origin: canonical_origin(&base),
        device_id: claim.device.id,
        secret: claim.device.secret,
        epoch: claim.authentication.epoch,
        clock_offset_seconds: offset,
        timestamp_window_seconds: claim.authentication.timestamp_window_seconds,
    };
    validate_credential(&credential, &canonical_origin(&base))?;
    let device_id = credential.device_id.clone();
    store_credential(credential).await?;
    Ok(CredentialStatus {
        paired: true,
        device_id: Some(device_id),
    })
}

#[tauri::command]
async fn credential_status(url: String) -> Result<CredentialStatus, String> {
    let base = validate_tailnet_url(&url)?;
    let credential = load_credential(&base).await?;
    Ok(CredentialStatus {
        paired: credential.is_some(),
        device_id: credential.map(|item| item.device_id),
    })
}

#[tauri::command]
async fn forget_device_credential(url: String) -> Result<CredentialStatus, String> {
    let base = validate_tailnet_url(&url)?;
    delete_credential(&base).await?;
    Ok(CredentialStatus {
        paired: false,
        device_id: None,
    })
}

#[tauri::command]
fn list_devices(app: AppHandle) -> Result<Vec<Device>, String> {
    let _guard = device_store_lock().lock().map_err(|_| "设备清单锁不可用")?;
    read_devices(&app)
}

#[tauri::command]
fn import_legacy_device_metadata(app: AppHandle) -> Result<LegacyDeviceImportResult, String> {
    let _guard = device_store_lock().lock().map_err(|_| "设备清单锁不可用")?;
    let config_directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    ensure_private_directory(&config_directory)?;
    let current_path = config_directory.join("devices.json");
    let legacy_path = legacy_devices_path_from_config_directory(&config_directory)?;
    import_legacy_device_metadata_paths(&current_path, &legacy_path)
}

#[tauri::command]
fn save_device(app: AppHandle, device: Device) -> Result<Vec<Device>, String> {
    validate_device(&device)?;
    let _guard = device_store_lock().lock().map_err(|_| "设备清单锁不可用")?;
    let mut devices = read_devices(&app)?;
    devices.retain(|item| item.id != device.id);
    devices.push(device);
    write_devices(&app, &devices)?;
    Ok(devices)
}

#[tauri::command]
fn remove_device(app: AppHandle, id: String) -> Result<Vec<Device>, String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("设备 ID 格式无效".into());
    }
    let _guard = device_store_lock().lock().map_err(|_| "设备清单锁不可用")?;
    let mut devices = read_devices(&app)?;
    devices.retain(|device| device.id != id);
    write_devices(&app, &devices)?;
    Ok(devices)
}

/// reqwest's Display hides the underlying cause ("error sending request...").
/// Walk the source chain so the UI can show the real reason (DNS, TLS, refused).
fn request_error_text(error: &reqwest::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        let text = cause.to_string();
        if !parts.contains(&text) {
            parts.push(text);
        }
        source = cause.source();
    }
    parts.join(" → ")
}

async fn inspect_pi_web(_client: &reqwest::Client, base_url: &str) -> DeviceStatus {
    let started = Instant::now();
    let Ok(base) = validate_tailnet_url(base_url) else {
        return DeviceStatus {
            state: "offline".into(),
            latency_ms: None,
            version: None,
            error: Some("设备健康检查地址无效".into()),
        };
    };
    let (metadata, offset) = match fetch_authentication_metadata(&base).await {
        Ok(value) => value,
        Err(error) => {
            return DeviceStatus {
                state: "offline".into(),
                latency_ms: None,
                version: None,
                error: Some(error),
            };
        }
    };
    let mut credential = match load_credential(&base).await {
        Ok(None) => {
            return DeviceStatus {
                state: "auth".into(),
                latency_ms: Some(started.elapsed().as_millis()),
                version: None,
                error: Some("此设备尚未配对".into()),
            };
        }
        Err(error) => {
            return DeviceStatus {
                state: "auth".into(),
                latency_ms: Some(started.elapsed().as_millis()),
                version: None,
                error: Some(error),
            };
        }
        Ok(Some(credential)) => credential,
    };
    if credential.epoch != metadata.epoch
        || credential.clock_offset_seconds.abs_diff(offset) > 2
        || credential.timestamp_window_seconds != metadata.timestamp_window_seconds
    {
        credential.epoch = metadata.epoch;
        credential.clock_offset_seconds = offset;
        credential.timestamp_window_seconds = metadata.timestamp_window_seconds;
        if let Err(error) = store_credential(credential).await {
            return DeviceStatus {
                state: "auth".into(),
                latency_ms: Some(started.elapsed().as_millis()),
                version: None,
                error: Some(error),
            };
        }
    }
    let Ok(endpoint) = validated_api_endpoint(
        &base,
        "/api/pihub/setup",
        ApiAccess::Generic { method: "GET" },
    ) else {
        return DeviceStatus {
            state: "offline".into(),
            latency_ms: None,
            version: None,
            error: Some("设备状态地址无效".into()),
        };
    };
    let spec =
        AuthenticatedRequestSpec::empty(reqwest::Method::GET, endpoint, Duration::from_secs(12))
            .accepting("application/json");
    match send_authenticated(&base, &spec).await {
        Ok(response) if response.status().is_success() => {
            let value = response.json::<Value>().await.ok();
            if value
                .as_ref()
                .and_then(|item| item.pointer("/security/tailnetOnly"))
                .and_then(Value::as_bool)
                == Some(false)
            {
                return DeviceStatus {
                    state: "offline".into(),
                    latency_ms: None,
                    version: None,
                    error: Some("服务端未启用 Tailnet-only 安全模式".into()),
                };
            }
            let version = value
                .as_ref()
                .and_then(|item| item.pointer("/server/version"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            DeviceStatus {
                state: "online".into(),
                latency_ms: Some(started.elapsed().as_millis()),
                version,
                error: value.is_none().then(|| "服务状态响应不是标准 JSON".into()),
            }
        }
        Ok(response) => DeviceStatus {
            state: "offline".into(),
            latency_ms: None,
            version: None,
            error: Some(format!("HTTP {}", response.status())),
        },
        Err(error) if error.starts_with("PIHUB_AUTH_") => DeviceStatus {
            state: "auth".into(),
            latency_ms: Some(started.elapsed().as_millis()),
            version: None,
            error: Some(error),
        },
        Err(error) => DeviceStatus {
            state: "offline".into(),
            latency_ms: None,
            version: None,
            error: Some(error),
        },
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BundledVersions {
    pihub_server: &'static str,
    app: &'static str,
}

#[tauri::command]
fn bundled_versions() -> BundledVersions {
    BundledVersions {
        pihub_server: PIHUB_SERVER_VERSION,
        app: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
async fn agegr_request(
    url: String,
    path: String,
    method: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let base = validate_tailnet_url(&url)?;
    let endpoint = validated_api_endpoint(&base, &path, ApiAccess::Generic { method: &method })?;
    // Long-running commands need a wider budget than plain state reads:
    // compact blocks on a full model call, and prompt/steer ack only after
    // extension preflight accepts the submission.
    let timeout_secs = match body
        .as_ref()
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
    {
        Some("compact") => 300,
        Some("prompt") | Some("steer") | Some("follow_up") | Some("ensure_session") => 90,
        _ => 30,
    };
    let request_method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "请求方法无效".to_owned())?;
    let spec = if let Some(value) = &body {
        AuthenticatedRequestSpec::json(
            request_method,
            endpoint,
            value,
            Duration::from_secs(timeout_secs),
        )?
    } else {
        AuthenticatedRequestSpec::empty(request_method, endpoint, Duration::from_secs(timeout_secs))
    };
    let response = send_authenticated(&base, &spec).await?;
    let (status, bytes) =
        response_bytes_limited_named(response, MAX_API_RESPONSE_BYTES, "服务端 API 响应").await?;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null)
    };
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("HTTP {status}")));
    }
    Ok(value)
}

#[derive(Debug, Serialize)]
struct ExportResult {
    path: String,
}

#[tauri::command]
async fn export_session_html(
    app: AppHandle,
    url: String,
    session_id: String,
    name: String,
) -> Result<ExportResult, String> {
    let base = validate_tailnet_url(&url)?;
    let encoded: String = url::form_urlencoded::byte_serialize(session_id.as_bytes()).collect();
    let endpoint = validated_api_endpoint(
        &base,
        &format!("/api/sessions/{encoded}/export"),
        ApiAccess::SessionExport,
    )?;
    let spec =
        AuthenticatedRequestSpec::empty(reqwest::Method::GET, endpoint, Duration::from_secs(60));
    let response = send_authenticated(&base, &spec).await?;
    let (status, html) =
        response_bytes_limited_named(response, MAX_SESSION_EXPORT_BYTES, "会话导出响应").await?;
    if !status.is_success() {
        return Err(format!("导出失败：HTTP {status}"));
    }
    std::str::from_utf8(&html).map_err(|_| "会话导出响应不是有效的 UTF-8".to_owned())?;
    let sanitized = portable_download_name(&name);
    let short_id: String = session_id.chars().take(8).collect();
    let (path, file) = reserve_download_path(&app, &format!("PiHub-{sanitized}-{short_id}.html"))?;
    write_reserved_download(&path, file, &html)?;
    Ok(ExportResult {
        path: path.to_string_lossy().into_owned(),
    })
}

fn portable_download_name(name: &str) -> String {
    let mut sanitized: String = name
        .chars()
        .take(160)
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect::<String>();
    sanitized = sanitized.trim_matches('.').to_owned();
    if sanitized.is_empty() {
        sanitized = "download.bin".into();
    }
    let stem = sanitized
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            });
    if reserved {
        sanitized.insert(0, '_');
    }
    sanitized
}

fn reserve_download_path(app: &AppHandle, name: &str) -> Result<(PathBuf, fs::File), String> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(|_| "无法定位系统下载目录".to_owned())?;
    fs::create_dir_all(&downloads).map_err(|error| format!("无法创建下载目录：{error}"))?;
    let sanitized = portable_download_name(name);
    let (stem, ext) = sanitized
        .rsplit_once('.')
        .filter(|(stem, extension)| !stem.is_empty() && !extension.is_empty())
        .map(|(stem, extension)| (stem.to_owned(), format!(".{extension}")))
        .unwrap_or((sanitized.clone(), String::new()));
    for index in 0..1_000 {
        let candidate = if index == 0 {
            sanitized.clone()
        } else {
            format!("{stem}-{index}{ext}")
        };
        let path = downloads.join(candidate);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建下载文件：{error}")),
        }
    }
    Err("下载目录中同名文件过多，请整理后重试".into())
}

fn remove_partial_download(path: &Path) {
    let _ = fs::remove_file(path);
}

fn write_reserved_download(path: &Path, mut file: fs::File, bytes: &[u8]) -> Result<(), String> {
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        remove_partial_download(path);
        return Err(format!("无法写入下载文件：{error}"));
    }
    Ok(())
}

#[tauri::command]
fn save_text_download(
    app: AppHandle,
    name: String,
    content: String,
) -> Result<ExportResult, String> {
    if content.len() > MAX_TEXT_DOWNLOAD_BYTES {
        return Err("文本下载内容超过 16MB 上限".into());
    }
    let (path, file) = reserve_download_path(&app, &name)?;
    write_reserved_download(&path, file, content.as_bytes())?;
    Ok(ExportResult {
        path: path.to_string_lossy().into_owned(),
    })
}

/// Streams a remote file to ~/Downloads as raw bytes — safe for binaries,
/// unlike the JSON `type=read` channel which assumes UTF-8 text.
#[tauri::command]
async fn download_remote_file(
    app: AppHandle,
    url: String,
    path: String,
    name: String,
) -> Result<ExportResult, String> {
    let base = validate_tailnet_url(&url)?;
    let endpoint = validated_api_endpoint(&base, &path, ApiAccess::FileDownload)?;
    let spec =
        AuthenticatedRequestSpec::empty(reqwest::Method::GET, endpoint, Duration::from_secs(300));
    let mut response = send_authenticated(&base, &spec).await?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载失败：HTTP {status}"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_REMOTE_DOWNLOAD_BYTES as u64)
    {
        return Err("远程文件超过 512MB 下载上限".into());
    }
    let (path, mut file) = reserve_download_path(&app, &name)?;
    let write_result: Result<(), String> = async {
        let mut written = 0usize;
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            written = written
                .checked_add(chunk.len())
                .ok_or_else(|| "远程文件大小溢出".to_owned())?;
            if written > MAX_REMOTE_DOWNLOAD_BYTES {
                return Err("远程文件超过 512MB 下载上限".into());
            }
            file.write_all(&chunk)
                .map_err(|error| format!("无法写入下载文件：{error}"))?;
        }
        file.sync_all()
            .map_err(|error| format!("无法完成下载文件：{error}"))?;
        Ok(())
    }
    .await;
    if let Err(error) = write_result {
        drop(file);
        remove_partial_download(&path);
        return Err(error);
    }
    Ok(ExportResult {
        path: path.to_string_lossy().into_owned(),
    })
}

fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    fn value(byte: u8) -> Result<u32, String> {
        match byte {
            b'A'..=b'Z' => Ok(u32::from(byte - b'A')),
            b'a'..=b'z' => Ok(u32::from(byte - b'a') + 26),
            b'0'..=b'9' => Ok(u32::from(byte - b'0') + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("无效的 base64 内容".to_owned()),
        }
    }
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if !bytes.chunks_exact(4).remainder().is_empty() {
        return Err("无效的 base64 长度".into());
    }
    let mut output = Vec::with_capacity(bytes.len() / 4 * 3);
    let chunk_count = bytes.len() / 4;
    for (chunk_index, chunk) in bytes.chunks(4).enumerate() {
        let pad = chunk.iter().rev().take_while(|&&byte| byte == b'=').count();
        if pad > 2 || (pad > 0 && chunk_index + 1 != chunk_count) {
            return Err("无效的 base64 填充".into());
        }
        if (pad == 2 && value(chunk[1])? & 0x0f != 0) || (pad == 1 && value(chunk[2])? & 0x03 != 0)
        {
            return Err("base64 内容不是规范编码".into());
        }
        let mut bits = 0u32;
        for (index, &byte) in chunk.iter().enumerate() {
            let digit = if index >= 4 - pad { 0 } else { value(byte)? };
            bits = (bits << 6) | digit;
        }
        output.push((bits >> 16) as u8);
        if pad < 2 {
            output.push((bits >> 8) as u8);
        }
        if pad < 1 {
            output.push(bits as u8);
        }
    }
    Ok(output)
}

#[derive(Debug, Deserialize)]
struct UploadFileIn {
    name: String,
    data: String,
}

fn validate_upload_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 255
        || matches!(name, "." | "..")
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':' | '"'))
    {
        return Err("上传文件名不符合跨平台安全规则".into());
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
    {
        return Err("上传文件名是 Windows 保留设备名".into());
    }
    Ok(())
}

fn multipart_upload_body(files: &[UploadFileIn], boundary: &str) -> Result<Bytes, String> {
    if boundary.is_empty()
        || boundary.len() > 70
        || !boundary
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("文件上传边界无效".into());
    }
    if files.is_empty() || files.len() > MAX_UPLOAD_FILES {
        return Err("每次必须上传 1 至 64 个文件".into());
    }
    let mut body = Vec::new();
    let mut decoded_total = 0usize;
    for file in files {
        validate_upload_name(&file.name)?;
        if file.data.len() > MAX_UPLOAD_FILE_BYTES.div_ceil(3) * 4 {
            return Err(format!("上传文件 {} 超过 64MB 上限", file.name));
        }
        let decoded = base64_decode(&file.data)?;
        if decoded.len() > MAX_UPLOAD_FILE_BYTES {
            return Err(format!("上传文件 {} 超过 64MB 上限", file.name));
        }
        decoded_total = decoded_total
            .checked_add(decoded.len())
            .ok_or_else(|| "上传文件总大小溢出".to_owned())?;
        if decoded_total > MAX_UPLOAD_TOTAL_BYTES {
            return Err("单次上传总大小超过 256MB 上限".into());
        }
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{}\"\r\nContent-Type: application/octet-stream\r\n\r\n", file.name).as_bytes());
        body.extend_from_slice(&decoded);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok(Bytes::from(body))
}

/// Multipart upload to the pi-web files API. The webview sends each file as
/// base64 (invoke payloads are JSON); we rebuild the bytes here so binaries
/// survive intact. Mirrors the web FileExplorer's `type=upload` contract.
#[tauri::command]
async fn upload_remote_files(
    url: String,
    path: String,
    files: Vec<UploadFileIn>,
) -> Result<Value, String> {
    let base = validate_tailnet_url(&url)?;
    let endpoint = validated_api_endpoint(&base, &path, ApiAccess::FileUpload)?;
    let mut boundary_random = [0u8; 18];
    getrandom::fill(&mut boundary_random).map_err(|_| "无法生成上传边界随机数".to_owned())?;
    let boundary = format!("pihub-upload-{}", URL_SAFE_NO_PAD.encode(boundary_random));
    let body = multipart_upload_body(&files, &boundary)?;
    let spec = AuthenticatedRequestSpec::bytes(
        reqwest::Method::POST,
        endpoint,
        body,
        format!("multipart/form-data; boundary={boundary}"),
        Duration::from_secs(300),
    );
    let response = send_authenticated(&base, &spec).await?;
    let (status, bytes) =
        response_bytes_limited_named(response, MAX_AUTH_RESPONSE_BYTES, "文件上传响应").await?;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null)
    };
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("HTTP {status}")));
    }
    Ok(value)
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct StreamKey {
    device_id: String,
    origin: String,
    session_id: String,
}

struct ActiveStream {
    generation: u64,
    cancel: tokio::sync::oneshot::Sender<()>,
}

fn stream_registry() -> &'static Mutex<HashMap<StreamKey, ActiveStream>> {
    static STREAMS: OnceLock<Mutex<HashMap<StreamKey, ActiveStream>>> = OnceLock::new();
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stream_key(device_id: String, base: &url::Url, session_id: String) -> Result<StreamKey, String> {
    if device_id.is_empty()
        || device_id.len() > 256
        || session_id.is_empty()
        || session_id.len() > 2048
        || device_id.chars().any(char::is_control)
        || session_id.chars().any(char::is_control)
    {
        return Err("设备或会话标识无效".into());
    }
    Ok(StreamKey {
        device_id,
        origin: base.origin().ascii_serialization(),
        session_id,
    })
}

fn install_stream(key: StreamKey) -> Result<(u64, tokio::sync::oneshot::Receiver<()>), String> {
    static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    let (cancel, receiver) = tokio::sync::oneshot::channel();
    let previous = stream_registry()
        .lock()
        .map_err(|_| "实时连接状态不可用")?
        .insert(key, ActiveStream { generation, cancel });
    if let Some(previous) = previous {
        let _ = previous.cancel.send(());
    }
    Ok((generation, receiver))
}

fn stream_is_current(key: &StreamKey, generation: u64) -> bool {
    stream_registry()
        .lock()
        .ok()
        .and_then(|streams| streams.get(key).map(|stream| stream.generation))
        == Some(generation)
}

fn cancel_stream(key: &StreamKey, generation: Option<u64>) -> Result<(), String> {
    let stream = {
        let mut streams = stream_registry().lock().map_err(|_| "实时连接状态不可用")?;
        if streams
            .get(key)
            .is_some_and(|stream| generation.is_none_or(|wanted| stream.generation == wanted))
        {
            streams.remove(key)
        } else {
            None
        }
    };
    if let Some(stream) = stream {
        let _ = stream.cancel.send(());
    }
    Ok(())
}

#[derive(Default)]
struct SseDecoder {
    line: Vec<u8>,
    data_lines: Vec<Vec<u8>>,
    data_bytes: usize,
    pending_cr: bool,
    saw_first_line: bool,
}

impl SseDecoder {
    fn buffered_bytes(&self) -> usize {
        self.line.len() + self.data_bytes + usize::from(self.pending_cr)
    }

    fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, String> {
        let mut events = Vec::new();
        for &byte in chunk {
            if self.pending_cr {
                self.pending_cr = false;
                if let Some(event) = self.finish_line()? {
                    events.push(event);
                }
                if byte == b'\n' {
                    continue;
                }
            }
            match byte {
                b'\r' => self.pending_cr = true,
                b'\n' => {
                    if let Some(event) = self.finish_line()? {
                        events.push(event);
                    }
                }
                _ => self.line.push(byte),
            }
            if self.buffered_bytes() > MAX_SSE_BUFFER_BYTES {
                return Err("实时事件缓冲区超过 1MB 上限".into());
            }
        }
        Ok(events)
    }

    fn finish(&mut self) -> Result<Vec<Value>, String> {
        let mut events = Vec::new();
        if self.pending_cr {
            self.pending_cr = false;
            if let Some(event) = self.finish_line()? {
                events.push(event);
            }
        } else if !self.line.is_empty() {
            if let Some(event) = self.finish_line()? {
                events.push(event);
            }
        }
        if let Some(event) = self.dispatch()? {
            events.push(event);
        }
        Ok(events)
    }

    fn finish_line(&mut self) -> Result<Option<Value>, String> {
        let mut line = std::mem::take(&mut self.line);
        if !self.saw_first_line {
            self.saw_first_line = true;
            if line.starts_with(&[0xef, 0xbb, 0xbf]) {
                line.drain(..3);
            }
        }
        if line.is_empty() {
            return self.dispatch();
        }
        if line.first() == Some(&b':') {
            return Ok(None);
        }
        let colon = line
            .iter()
            .position(|byte| *byte == b':')
            .unwrap_or(line.len());
        if &line[..colon] != b"data" {
            return Ok(None);
        }
        let mut value = if colon == line.len() {
            Vec::new()
        } else {
            line[colon + 1..].to_vec()
        };
        if value.first() == Some(&b' ') {
            value.remove(0);
        }
        self.data_bytes = self
            .data_bytes
            .saturating_add(value.len() + usize::from(!self.data_lines.is_empty()));
        self.data_lines.push(value);
        if self.buffered_bytes() > MAX_SSE_BUFFER_BYTES {
            return Err("实时事件缓冲区超过 1MB 上限".into());
        }
        Ok(None)
    }

    fn dispatch(&mut self) -> Result<Option<Value>, String> {
        if self.data_lines.is_empty() {
            return Ok(None);
        }
        let mut data = Vec::with_capacity(self.data_bytes);
        for (index, line) in self.data_lines.drain(..).enumerate() {
            if index > 0 {
                data.push(b'\n');
            }
            data.extend(line);
        }
        self.data_bytes = 0;
        let text = std::str::from_utf8(&data).map_err(|_| "实时事件不是有效的 UTF-8".to_owned())?;
        serde_json::from_str(text)
            .map(Some)
            .map_err(|_| "实时事件不是有效的 JSON".to_owned())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStreamPayload {
    device_id: String,
    device_origin: String,
    session_id: String,
    generation: u64,
    event: Value,
}

fn emit_agent_stream_event(
    app: &AppHandle,
    key: &StreamKey,
    generation: u64,
    event: Value,
    ready: &mut Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
) -> Result<bool, String> {
    if !stream_is_current(key, generation) {
        return Ok(false);
    }
    let event_type = event.get("type").and_then(Value::as_str);
    if event_type == Some("connected") {
        if let Some(sender) = ready.take() {
            let _ = sender.send(Ok(()));
        }
    }
    let startup_error = (event_type == Some("startup_error")).then(|| {
        event
            .get("errorMessage")
            .and_then(Value::as_str)
            .unwrap_or("实时会话启动失败")
            .to_owned()
    });
    app.emit(
        "pihub-agent-event",
        AgentStreamPayload {
            device_id: key.device_id.clone(),
            device_origin: key.origin.clone(),
            session_id: key.session_id.clone(),
            generation,
            event,
        },
    )
    .map_err(|error| format!("无法投递实时事件：{error}"))?;
    if let Some(message) = startup_error {
        if let Some(sender) = ready.take() {
            let _ = sender.send(Err(message.clone()));
        }
        return Err(message);
    }
    Ok(true)
}

#[tauri::command]
async fn start_agent_stream(
    app: AppHandle,
    url: String,
    device_id: String,
    session_id: String,
) -> Result<u64, String> {
    let base = validate_tailnet_url(&url)?;
    let key = stream_key(device_id, &base, session_id)?;
    let encoded: String = url::form_urlencoded::byte_serialize(key.session_id.as_bytes()).collect();
    let endpoint = validated_api_endpoint(
        &base,
        &format!("/api/agent/{encoded}/events"),
        ApiAccess::AgentStream,
    )?;
    let spec =
        AuthenticatedRequestSpec::empty(reqwest::Method::GET, endpoint, Duration::from_secs(30))
            .accepting("text/event-stream")
            .without_timeout();
    let (generation, mut cancel_rx) = install_stream(key.clone())?;
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let task_key = key.clone();
    let task_base = base.clone();
    tauri::async_runtime::spawn(async move {
        let mut ready_tx = Some(ready_tx);
        let run: Result<(), String> = async {
            let response = tokio::select! {
                _ = &mut cancel_rx => return Ok(()),
                response = send_authenticated(&task_base, &spec) => response?,
            };
            if !response.status().is_success() {
                return Err(format!("实时连接返回 HTTP {}", response.status()));
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            if !content_type
                .split(';')
                .next()
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"))
            {
                return Err("实时连接返回了错误的内容类型".into());
            }
            let mut response = response;
            let mut decoder = SseDecoder::default();
            loop {
                let chunk = tokio::select! {
                    _ = &mut cancel_rx => return Ok(()),
                    chunk = response.chunk() => chunk.map_err(|error| error.to_string())?,
                };
                let Some(chunk) = chunk else {
                    for event in decoder.finish()? {
                        if !emit_agent_stream_event(
                            &app,
                            &task_key,
                            generation,
                            event,
                            &mut ready_tx,
                        )? {
                            return Ok(());
                        }
                    }
                    return Err("实时连接已关闭".into());
                };
                for event in decoder.push(&chunk)? {
                    if !emit_agent_stream_event(&app, &task_key, generation, event, &mut ready_tx)?
                    {
                        return Ok(());
                    }
                }
            }
        }
        .await;
        if let Err(error) = run {
            if stream_is_current(&task_key, generation) {
                if let Some(sender) = ready_tx.take() {
                    let _ = sender.send(Err(error.clone()));
                }
                let _ = app.emit(
                    "pihub-agent-event",
                    AgentStreamPayload {
                        device_id: task_key.device_id.clone(),
                        device_origin: task_key.origin.clone(),
                        session_id: task_key.session_id.clone(),
                        generation,
                        event: serde_json::json!({ "type": "stream_error", "errorMessage": error }),
                    },
                );
            }
        }
        let _ = cancel_stream(&task_key, Some(generation));
    });

    match tokio::time::timeout(std::time::Duration::from_secs(30), ready_rx).await {
        Ok(Ok(Ok(()))) => Ok(generation),
        Ok(Ok(Err(error))) => {
            let _ = cancel_stream(&key, Some(generation));
            Err(error)
        }
        Ok(Err(_)) => {
            let _ = cancel_stream(&key, Some(generation));
            Err("实时会话连接提前关闭".into())
        }
        Err(_) => {
            let _ = cancel_stream(&key, Some(generation));
            Err("等待实时会话连接超时，已取消后台连接".into())
        }
    }
}

#[tauri::command]
fn stop_agent_stream(url: String, device_id: String, session_id: String) -> Result<(), String> {
    let base = validate_tailnet_url(&url)?;
    let key = stream_key(device_id, &base, session_id)?;
    cancel_stream(&key, None)
}

#[tauri::command]
async fn probe_device(url: String) -> Result<DeviceStatus, String> {
    let base = validate_tailnet_url(&url)?;
    // Tailscale Serve can take several seconds for the first TLS handshake.
    let client = tailnet_http_client(&base).await?;
    let mut status = tokio::time::timeout(
        std::time::Duration::from_secs(12),
        inspect_pi_web(&client, &url),
    )
    .await
    .unwrap_or(DeviceStatus {
        state: "offline".into(),
        latency_ms: None,
        version: None,
        error: Some("连接超时，请检查 Tailscale 路由".into()),
    });
    // Attach tailnet diagnostics so the card shows *why* it is unreachable.
    if status.state == "offline" {
        if let Some(host) = base.host_str() {
            let note = match tailnet_ip_for_hostname(host).await {
                Ok(Some(ip)) => format!("（Tailscale 节点 IP：{ip}）"),
                Ok(None) => {
                    "（tailscale status 中未找到该节点，或本机 Tailscale 未运行）".to_owned()
                }
                Err(error) => format!("（tailscale status 不可用：{error}）"),
            };
            status.error = Some(format!("{} {}", status.error.unwrap_or_default(), note));
        }
    }
    Ok(status)
}

fn tailscale_command() -> Option<bootstrap::LocalExecutable> {
    bootstrap::discover_tailscale_executable()
}

fn tailscale_approval_url(output: &str) -> Option<String> {
    let marker = "https://login.tailscale.com/";
    let start = output.find(marker)?;
    let value = output[start..].split_whitespace().next()?;
    Some(
        value
            .trim_end_matches([')', ']', '}', ',', '.', ';'])
            .to_owned(),
    )
}

fn render_standalone_bootstrap_helper() -> String {
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

fn render_windows_bootstrap_script(install_extensions: bool) -> String {
    include_str!("bootstrap_windows.ps1")
        .replace(
            "__STANDALONE_BOOTSTRAP__",
            &base64_encode(render_standalone_bootstrap_helper().as_bytes()),
        )
        .replace(
            "__INSTALL_EXTENSIONS__",
            if install_extensions { "1" } else { "0" },
        )
}

fn render_unix_bootstrap_script(install_extensions: bool) -> String {
    include_str!("bootstrap_unix.sh")
        .replace(
            "__STANDALONE_BOOTSTRAP__",
            &base64_encode(render_standalone_bootstrap_helper().as_bytes()),
        )
        .replace(
            "__INSTALL_EXTENSIONS__",
            if install_extensions { "1" } else { "0" },
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

fn unix_bootstrap_ssh_user(
    os: Option<&str>,
    username: Option<&str>,
) -> Result<Option<String>, String> {
    let candidate = username.map(str::trim).filter(|value| !value.is_empty());
    let is_linux = os.is_some_and(|value| value.eq_ignore_ascii_case("linux"));
    if is_linux && candidate.is_none() {
        return Err("Linux Tailscale SSH 需要远端非 root 用户名".into());
    }
    let normalized = candidate
        .map(|value| bootstrap::normalize_ssh_username(value, false))
        .transpose()?;
    if is_linux && normalized.as_deref() == Some("root") {
        return Err("PiHub Server 不能以 root 身份安装；请输入普通 Linux 用户名".into());
    }
    Ok(normalized)
}

#[tauri::command]
fn open_tailscale_approval(app: AppHandle, url: String) -> Result<(), String> {
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

#[tauri::command]
async fn bootstrap_tailnet_peer(
    app: AppHandle,
    host: String,
    os: Option<String>,
    username: Option<String>,
    install_default_extensions: bool,
) -> Result<BootstrapResult, String> {
    let normalized = bootstrap::normalize_tailscale_host(&host)?;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let is_windows = os
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("windows"));
    let specification = if is_windows {
        let user = username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or("Windows OpenSSH 需要远端 Windows 用户名")?;
        let executable = bootstrap::discover_ssh_executable()
            .ok_or("未找到系统 OpenSSH 客户端；请安装或启用 OpenSSH Client 后重试")?;
        let args = bootstrap::windows_ssh_args(user, &normalized)?;
        let script = render_windows_bootstrap_script(install_default_extensions);
        bootstrap::BoundedCommand {
            executable,
            args,
            current_dir: Some(config_dir.clone()),
            stdin: bootstrap::BootstrapStdin::WindowsFrame { script },
        }
    } else {
        let executable = tailscale_command().ok_or("未找到 Tailscale 客户端")?;
        let ssh_user = unix_bootstrap_ssh_user(os.as_deref(), username.as_deref())?;
        let target = ssh_user
            .map(|user| format!("{user}@{normalized}"))
            .unwrap_or_else(|| normalized.clone());
        let script = render_unix_bootstrap_script(install_default_extensions);
        bootstrap::BoundedCommand {
            executable,
            args: vec!["ssh".into(), target.into(), script.into()],
            current_dir: Some(config_dir),
            stdin: bootstrap::BootstrapStdin::Raw(Vec::new()),
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

type PeerValue = (String, String, Option<String>, String, Option<String>, bool);
type ProbeInput = (
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    bool,
    String,
);

fn peer_from_value(id: &str, value: &Value, is_self: bool) -> Option<PeerValue> {
    let dns = value
        .get("DNSName")
        .and_then(Value::as_str)
        .map(|s| s.trim_end_matches('.').to_owned());
    let name = value
        .get("HostName")
        .and_then(Value::as_str)
        .or_else(|| dns.as_deref().and_then(|s| s.split('.').next()))?
        .to_owned();
    let ips = value.get("TailscaleIPs").and_then(Value::as_array)?;
    let ip = ips
        .iter()
        .filter_map(Value::as_str)
        .filter_map(|value| value.parse::<IpAddr>().ok())
        .filter(|ip| is_tailscale_ip(*ip))
        .find(IpAddr::is_ipv4)
        .or_else(|| {
            ips.iter()
                .filter_map(Value::as_str)
                .filter_map(|value| value.parse::<IpAddr>().ok())
                .find(|ip| is_tailscale_ip(*ip))
        })?
        .to_string();
    let os = value.get("OS").and_then(Value::as_str).map(|s| match s {
        "macOS" | "darwin" => "macOS".to_owned(),
        other => other.to_owned(),
    });
    let online = is_self
        || value
            .get("Online")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    Some((
        if id.is_empty() {
            name.clone()
        } else {
            id.to_owned()
        },
        name,
        dns,
        ip,
        os,
        online,
    ))
}

fn tailnet_origin(host: &str, port: u16) -> String {
    if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("https://[{host}]:{port}")
    } else {
        format!("https://{host}:{port}")
    }
}

#[tauri::command]
async fn discover_tailscale(
    port: Option<u16>,
    probe_services: Option<bool>,
) -> Result<TailnetScan, String> {
    let probe_services = probe_services.unwrap_or(true);
    if tailscale_command().is_none() {
        return Ok(TailnetScan {
            available: false,
            tailnet: None,
            peers: vec![],
            message: Some("未找到 Tailscale。请先安装适用于当前系统的 Tailscale 客户端。".into()),
        });
    };
    let root = match tailscale_status().await {
        Ok(root) => root,
        Err(message) => {
            return Ok(TailnetScan {
                available: false,
                tailnet: None,
                peers: vec![],
                message: Some(message),
            })
        }
    };
    let tailnet = root
        .pointer("/CurrentTailnet/Name")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let mut raw: Vec<(String, &Value, bool)> = Vec::new();
    if let Some(me) = root.get("Self") {
        raw.push(("self".into(), me, true));
    }
    if let Some(peers) = root.get("Peer").and_then(Value::as_object) {
        raw.extend(peers.iter().map(|(id, peer)| (id.clone(), peer, false)));
    }
    let mut peers = Vec::new();
    let mut probe_inputs: Vec<ProbeInput> = Vec::new();
    let mut probe_states: Vec<Option<DeviceStatus>> = Vec::new();
    let mut probe_tasks = tokio::task::JoinSet::new();
    let probe_permits = Arc::new(tokio::sync::Semaphore::new(MAX_TAILNET_PROBE_CONCURRENCY));
    let service_port = port.unwrap_or(30141);
    let mut discovered_peers = 0usize;
    let mut peer_limit_reached = false;
    let mut probe_limit_reached = false;
    for (id, value, is_self) in raw {
        let Some((peer_id, name, dns, ip, os, online)) = peer_from_value(&id, value, is_self)
        else {
            continue;
        };
        if !online {
            continue;
        }
        if discovered_peers >= MAX_DISCOVERED_TAILNET_PEERS {
            peer_limit_reached = true;
            break;
        }
        discovered_peers += 1;
        let host = dns.clone().unwrap_or_else(|| ip.clone());
        // Discovery mode checks the PiHub HTTPS endpoint. SSH setup mode must
        // never probe the application port because a new node has no server
        // yet; it only enumerates online Tailnet peers for bootstrap.
        if probe_services && probe_inputs.len() < MAX_TAILNET_SERVICE_PROBES {
            let probe_host = dns.as_deref().unwrap_or(&ip);
            let url = tailnet_origin(probe_host, service_port);
            let parsed = validate_tailnet_url(&url)?;
            let verified_ip = ip
                .parse::<IpAddr>()
                .ok()
                .filter(|ip| is_tailscale_ip(*ip))
                .ok_or("tailscale status 返回了非法节点地址")?;
            let client = build_tailnet_http_client(&parsed, Some(verified_ip))?;
            probe_inputs.push((peer_id, name, host, dns, ip, os, is_self, url.clone()));
            let index = probe_states.len();
            probe_states.push(None);
            let permits = Arc::clone(&probe_permits);
            probe_tasks.spawn(async move {
                let Ok(_permit) = permits.acquire_owned().await else {
                    return (
                        index,
                        DeviceStatus {
                            state: "offline".into(),
                            latency_ms: None,
                            version: None,
                            error: None,
                        },
                    );
                };
                // DERP-relayed nodes need several seconds per TLS handshake; a
                // short timeout here permanently hides slow-but-working servers.
                let status = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    inspect_pi_web(&client, &url),
                )
                .await
                .unwrap_or(DeviceStatus {
                    state: "offline".into(),
                    latency_ms: None,
                    version: None,
                    error: None,
                });
                (index, status)
            });
        } else {
            probe_limit_reached |= probe_services;
            let url = dns
                .as_deref()
                .map(|dns_host| tailnet_origin(dns_host, service_port))
                .unwrap_or_default();
            peers.push(TailnetPeer {
                id: peer_id,
                name,
                host,
                dns_name: dns,
                ip,
                os,
                online,
                is_self,
                pi_web: false,
                requires_auth: false,
                url,
                latency_ms: None,
                version: None,
            });
        }
    }
    while let Some(joined) = probe_tasks.join_next().await {
        let (index, status) = joined.map_err(|error| error.to_string())?;
        probe_states[index] = Some(status);
    }
    for ((peer_id, name, host, dns, ip, os, is_self, url), status) in
        probe_inputs.into_iter().zip(probe_states)
    {
        let result = status.unwrap_or(DeviceStatus {
            state: "offline".into(),
            latency_ms: None,
            version: None,
            error: None,
        });
        let requires_auth = result.state == "auth";
        peers.push(TailnetPeer {
            id: peer_id,
            name,
            host,
            dns_name: dns,
            ip,
            os,
            online: true,
            is_self,
            pi_web: result.state == "online" || requires_auth,
            requires_auth,
            url,
            latency_ms: result.latency_ms,
            version: result.version,
        });
    }
    peers.sort_by_key(|peer| (!peer.pi_web, !peer.is_self, peer.name.to_lowercase()));
    let mut notices = Vec::new();
    if peer_limit_reached {
        notices.push(format!(
            "节点较多，仅显示前 {MAX_DISCOVERED_TAILNET_PEERS} 个在线节点"
        ));
    }
    if probe_limit_reached {
        notices.push(format!(
            "仅探测前 {MAX_TAILNET_SERVICE_PROBES} 个在线节点的 PiHub 服务"
        ));
    }
    Ok(TailnetScan {
        available: true,
        tailnet,
        peers,
        message: (!notices.is_empty()).then(|| notices.join("；")),
    })
}

#[tauri::command]
fn open_device(app: AppHandle, device: Device) -> Result<(), String> {
    let hash = hex::encode(Sha256::digest(device.url.as_bytes()));
    let label = format!("device-{}", &hash[..12]);
    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let route = format!(
        "index.html?workspace={}",
        url::form_urlencoded::byte_serialize(device.id.as_bytes()).collect::<String>()
    );
    let builder = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(route.into()))
        .title(device.name.clone())
        .inner_size(1280.0, 820.0)
        .min_inner_size(780.0, 520.0);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true);
    builder
        // Keep every device as a normal native macOS window. The green traffic-light
        // button then uses macOS full screen, which automatically creates a Space.
        .decorations(true)
        .resizable(true)
        .maximizable(true)
        .fullscreen(false)
        .center()
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(desktop_updater::DesktopUpdaterState::new(env!(
            "CARGO_PKG_VERSION"
        )))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(desktop_updater::pinned_public_key())
                .build(),
        )
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            list_devices,
            import_legacy_device_metadata,
            save_device,
            remove_device,
            pair_device,
            credential_status,
            forget_device_credential,
            probe_device,
            discover_tailscale,
            bootstrap_tailnet_peer,
            open_tailscale_approval,
            open_device,
            agegr_request,
            start_agent_stream,
            stop_agent_stream,
            export_session_html,
            save_text_download,
            download_remote_file,
            upload_remote_files,
            bundled_versions,
            desktop_updater::desktop_update_status,
            desktop_updater::desktop_update_check,
            desktop_updater::desktop_update_install,
            desktop_updater::desktop_update_cancel,
            desktop_updater::desktop_update_restart
        ])
        .run(tauri::generate_context!())
        .expect("error while running PiHub");
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real-network smoke test for the Tailscale probe path:
    // cargo test probe_oracle -- --nocapture --ignored
    #[test]
    #[ignore]
    fn probe_oracle() {
        let Ok(url) = std::env::var("PIHUB_PROBE_URL") else {
            eprintln!("未设置 PIHUB_PROBE_URL，跳过真实 Tailnet 探测");
            return;
        };
        let base = validate_tailnet_url(&url).expect("validate");
        let client = tauri::async_runtime::block_on(tailnet_http_client(&base)).expect("client");
        let status = tauri::async_runtime::block_on(inspect_pi_web(&client, &url));
        println!(
            "state={} error={:?} version={:?} latency={:?}",
            status.state, status.error, status.version, status.latency_ms
        );
        assert_eq!(status.state, "online");
    }

    #[test]
    fn base64_roundtrip() {
        // Every residue class plus non-UTF8 bytes (the upload path carries binaries).
        let mut data: Vec<u8> = (0u16..=255).map(|b| b as u8).collect();
        for len in [0usize, 1, 2, 3, 4, 255, 256] {
            let slice = &data[..len];
            assert_eq!(
                base64_decode(&base64_encode(slice)).unwrap(),
                slice,
                "len={len}"
            );
        }
        data.extend([0, 159, 146, 150]); // invalid UTF-8 must survive
        assert_eq!(base64_decode(&base64_encode(&data)).unwrap(), data);
        assert!(base64_decode("abc").is_err());
        assert!(base64_decode("!!!!").is_err());
    }

    #[test]
    fn windows_bootstrap_script_embeds_the_signed_standalone_installer() {
        let script = render_windows_bootstrap_script(true);
        assert!(script.starts_with("$ErrorActionPreference = 'Stop'"));
        assert!(script.contains("PIHUB_BOOTSTRAP_OK"));
        assert!(script.contains("major>22||(major===22&&minor>=19)"));
        assert!(script.contains("if ('1' -eq '1')"));
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
    fn linux_bootstrap_requires_an_explicit_unprivileged_ssh_user() {
        assert_eq!(
            unix_bootstrap_ssh_user(Some("linux"), Some("pi-user")).unwrap(),
            Some("pi-user".into())
        );
        assert!(unix_bootstrap_ssh_user(Some("Linux"), None).is_err());
        assert!(unix_bootstrap_ssh_user(Some("linux"), Some("root")).is_err());
        assert_eq!(unix_bootstrap_ssh_user(Some("macos"), None).unwrap(), None);
    }

    #[test]
    fn unix_bootstrap_is_posix_and_verifies_downloaded_node_archives() {
        let script = render_unix_bootstrap_script(false);
        assert!(script.starts_with("set -eu\n"));
        assert!(script.contains("trap cleanup 0"));
        assert!(!script.contains("trap '"));
        assert!(!script.contains(" ERR"));
        assert!(script.contains(PIHUB_NODE_LINUX_X64_SHA256));
        assert!(script.contains(PIHUB_NODE_LINUX_ARM64_SHA256));
        assert!(script.contains(PIHUB_NODE_DARWIN_X64_SHA256));
        assert!(script.contains(PIHUB_NODE_DARWIN_ARM64_SHA256));
        assert!(script.contains("actual_sha256"));
        assert!(script.contains("https://nodejs.org/dist/"));
        assert!(script.contains("if [ '0' = '1' ]"));
        assert!(!script.contains("npm install"));
        assert!(!script.contains("npx"));
        assert!(!script.contains("pihub-server.tgz"));
        assert!(!script.contains("--location"));
        assert!(!script.contains("__STANDALONE_BOOTSTRAP__"));
        assert!(!script.contains("__INSTALL_EXTENSIONS__"));
        assert!(!script.contains("__NODE_"));
        assert!(script.len() <= bootstrap::MAX_BOOTSTRAP_SCRIPT_BYTES);
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
        assert!(!helper.contains("pi-magic-context"));
    }

    #[cfg(unix)]
    #[test]
    fn rendered_unix_bootstrap_passes_the_system_shell_parser() {
        use std::io::Write as _;

        let script = render_unix_bootstrap_script(true);
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

    #[cfg(windows)]
    #[test]
    fn rendered_windows_bootstrap_passes_the_system_powershell_parser() {
        use std::io::Write as _;

        let script = render_windows_bootstrap_script(true);
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

    fn test_base() -> url::Url {
        validate_tailnet_url("https://device.example.ts.net:30141").unwrap()
    }

    #[test]
    fn tailnet_base_is_an_origin_without_credentials() {
        for rejected in [
            "https://user@device.example.ts.net:30141",
            "https://user:secret@device.example.ts.net:30141",
            "https://device.example.ts.net:30141/api",
            "https://device.example.ts.net:30141/?query=1",
            "https://device.example.ts.net:30141/#fragment",
            "https://device.example.ts.net:30141\\api",
        ] {
            assert!(
                validate_tailnet_url(rejected).is_err(),
                "accepted {rejected}"
            );
        }
        assert!(validate_tailnet_url("https://device.example.ts.net:30141").is_ok());
        assert!(validate_tailnet_url("https://100.64.0.1:30141/").is_ok());
    }

    #[test]
    fn tailnet_status_binding_requires_exact_dns_and_tailscale_ip() {
        let status = serde_json::json!({
            "Self": {
                "DNSName": "self.example.ts.net.",
                "TailscaleIPs": ["203.0.113.5", "100.64.0.2"]
            },
            "Peer": {
                "peer-id": {
                    "DNSName": "peer.example.ts.net.",
                    "TailscaleIPs": ["192.0.2.10", "fd7a:115c:a1e0::7"]
                }
            }
        });
        assert_eq!(
            tailnet_ip_from_status(&status, "SELF.EXAMPLE.TS.NET"),
            Some("100.64.0.2".parse().unwrap())
        );
        assert_eq!(
            tailnet_ip_from_status(&status, "peer.example.ts.net"),
            Some("fd7a:115c:a1e0::7".parse().unwrap())
        );
        assert_eq!(
            tailnet_ip_from_status(&status, "missing.example.ts.net"),
            None
        );
    }

    #[test]
    fn tailnet_client_cache_has_ttl_and_lru_capacity() {
        let mut cache = TailnetClientCache::default();
        let client = reqwest::Client::new();
        let start = Instant::now();
        for index in 0..TAILNET_CLIENT_CACHE_CAPACITY {
            cache.insert(
                format!("origin-{index}"),
                client.clone(),
                start + Duration::from_millis(index as u64),
            );
        }
        let touched_at = start + Duration::from_secs(1);
        assert!(cache.get("origin-0", touched_at).is_some());
        cache.insert(
            "overflow".into(),
            client,
            touched_at + Duration::from_millis(1),
        );
        assert_eq!(cache.entries.len(), TAILNET_CLIENT_CACHE_CAPACITY);
        assert!(cache.entries.contains_key("origin-0"));
        assert!(!cache.entries.contains_key("origin-1"));
        assert!(cache.entries.contains_key("overflow"));

        assert!(cache
            .get(
                "origin-0",
                start + TAILNET_CLIENT_CACHE_TTL + Duration::from_secs(2),
            )
            .is_none());
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn tailnet_origin_brackets_ipv6() {
        assert_eq!(
            tailnet_origin("fd7a:115c:a1e0::7", 30141),
            "https://[fd7a:115c:a1e0::7]:30141"
        );
        assert_eq!(
            tailnet_origin("peer.example.ts.net", 30141),
            "https://peer.example.ts.net:30141"
        );
    }

    #[test]
    fn generic_api_uses_structured_route_allowlist() {
        let base = test_base();
        for (path, method) in [
            ("/api/sessions", "GET"),
            ("/api/sessions/session-1?desktop=1&limit=40", "GET"),
            ("/api/agent/session-1", "POST"),
            (
                "/api/files/C%3A/Users/demo/file.txt?type=read&sessionId=s1",
                "GET",
            ),
            ("/api/pihub/terminal?id=t1&offset=0", "GET"),
        ] {
            assert!(
                validated_api_endpoint(&base, path, ApiAccess::Generic { method }).is_ok(),
                "rejected {method} {path}"
            );
        }

        for (path, method) in [
            ("/api/unknown", "GET"),
            ("/api/sessions", "POST"),
            ("/api/sessions?unexpected=1", "GET"),
            ("/api/sessions/session-1?limit=999", "GET"),
            ("/api/files/a?type=download&sessionId=s1", "GET"),
            ("/api/files/a?type=read&sessionId=s1&sessionId=s2", "GET"),
            ("/api/agent/session-1/events", "GET"),
        ] {
            assert!(
                validated_api_endpoint(&base, path, ApiAccess::Generic { method }).is_err(),
                "accepted {method} {path}"
            );
        }
    }

    #[test]
    fn api_endpoint_rejects_join_and_encoding_bypasses() {
        let base = test_base();
        for path in [
            "https://100.64.0.2:30141/api/sessions",
            "//100.64.0.2:30141/api/sessions",
            "/api/sessions/../pihub/setup",
            "/api/sessions/%2e%2e/pihub/setup",
            "/api/sessions/%252e%252e/pihub/setup",
            "/api/sessions/%2f%2fevil.example/api",
            "/api/sessions/%255cevil",
            "/api/sessions#fragment",
            "/api//sessions",
            "/api/sessions/%zz",
        ] {
            assert!(
                validated_api_endpoint(&base, path, ApiAccess::Generic { method: "GET" }).is_err(),
                "accepted {path}"
            );
        }
    }

    #[test]
    fn file_commands_remain_under_files_api_after_normalization() {
        let base = test_base();
        assert!(validated_api_endpoint(
            &base,
            "/api/files/project/file.bin?type=download&sessionId=s1",
            ApiAccess::FileDownload,
        )
        .is_ok());
        assert!(validated_api_endpoint(
            &base,
            "/api/files/project?type=upload&conflict=overwrite",
            ApiAccess::FileUpload,
        )
        .is_ok());

        for path in [
            "/api/files/../sessions?type=download&sessionId=s1",
            "/api/files/%2e%2e/sessions?type=download&sessionId=s1",
            "/api/files/%252e%252e/sessions?type=download&sessionId=s1",
            "/api/files/project?type=read&sessionId=s1",
        ] {
            assert!(
                validated_api_endpoint(&base, path, ApiAccess::FileDownload).is_err(),
                "accepted {path}"
            );
        }
        assert!(validated_api_endpoint(
            &base,
            "/api/files/project?type=upload&conflict=overwrite&redirect=https%3A%2F%2Fevil.example",
            ApiAccess::FileUpload,
        )
        .is_err());
    }

    #[test]
    fn sse_decoder_handles_crlf_multiline_and_split_utf8() {
        let bytes = "\u{feff}: keepalive\r\ndata: {\"type\":\"message\",\r\ndata: \"text\":\"你好🌟\"}\r\n\r\n\ndata: {\"type\":\"done\"}\n\n".as_bytes();
        let star = bytes
            .windows("🌟".len())
            .position(|window| window == "🌟".as_bytes())
            .unwrap();
        let splits = [1, 7, star + 1, star + 3, bytes.len() - 3, bytes.len()];
        let mut decoder = SseDecoder::default();
        let mut events = Vec::new();
        let mut start = 0;
        for end in splits {
            if end <= start {
                continue;
            }
            events.extend(decoder.push(&bytes[start..end]).unwrap());
            start = end;
        }
        events.extend(decoder.finish().unwrap());
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["text"], "你好🌟");
        assert_eq!(events[1]["type"], "done");
    }

    #[test]
    fn sse_decoder_rejects_invalid_utf8_json_and_unbounded_frames() {
        let mut invalid_utf8 = SseDecoder::default();
        assert!(invalid_utf8.push(b"data: \xff\n\n").is_err());

        let mut invalid_json = SseDecoder::default();
        assert!(invalid_json.push(b"data: not-json\n\n").is_err());

        let mut oversized = SseDecoder::default();
        let huge = vec![b'a'; MAX_SSE_BUFFER_BYTES + 1];
        assert!(oversized.push(&huge).is_err());
    }

    #[tokio::test]
    async fn stream_cancellation_isolated_by_device_and_session() {
        let base = test_base();
        let suffix = std::process::id().to_string();
        let first =
            stream_key(format!("device-a-{suffix}"), &base, "shared-session".into()).unwrap();
        let second =
            stream_key(format!("device-b-{suffix}"), &base, "shared-session".into()).unwrap();
        let (_, first_cancelled) = install_stream(first.clone()).unwrap();
        let (_, mut second_cancelled) = install_stream(second.clone()).unwrap();

        cancel_stream(&first, None).unwrap();
        assert!(first_cancelled.await.is_ok());
        assert!(matches!(
            second_cancelled.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        cancel_stream(&second, None).unwrap();
        assert!(second_cancelled.await.is_ok());
    }

    fn signing_credential() -> StoredCredential {
        StoredCredential {
            version: PIHUB_CREDENTIAL_VERSION,
            origin: "https://device.example.ts.net:30141".into(),
            device_id: "dev_AAAAAAAAAAAAAAAAAAAAAA".into(),
            secret: format!("pihub_key_{}", "B".repeat(43)),
            epoch: "G".repeat(22),
            clock_offset_seconds: 0,
            timestamp_window_seconds: 120,
        }
    }

    #[test]
    fn canonical_target_matches_whatwg_url_search_params() {
        for (input, expected) in [
            (
                "https://x.invalid/api/files/a%20b?z=2&a=x%20y&a=x",
                "/api/files/a%20b?a=x+y&a=x&z=2",
            ),
            (
                "https://x.invalid/api/%7e/%21/%2A/%2B/%E4%BD%A0?space=a+b&tilde=~&encoded=%7e&star=*&plus=%2B",
                "/api/~/%21/%2A/%2B/%E4%BD%A0?encoded=%7E&plus=%2B&space=a+b&star=*&tilde=%7E",
            ),
            (
                "https://x.invalid/api/test?%EE%80%80=bmp&%F0%9F%98%80=astral&a=first&a=second",
                "/api/test?a=first&a=second&%F0%9F%98%80=astral&%EE%80%80=bmp",
            ),
        ] {
            let endpoint = url::Url::parse(input).unwrap();
            assert_eq!(canonical_request_target(&endpoint).unwrap(), expected);
        }
    }

    #[test]
    fn v3_authorization_matches_server_fixed_vector() {
        let spec = AuthenticatedRequestSpec {
            method: reqwest::Method::POST,
            endpoint: url::Url::parse(
                "https://pi.invalid/api/agent/new?z=2&name=hello%20world&a=%2F",
            )
            .unwrap(),
            body: None,
            content_type: None,
            accept: None,
            content_sha256: "9b2d43affbf49a367028df2e1414f84c0e099ac98c3d54a8a80157fd7771af25"
                .into(),
            timeout: Some(Duration::from_secs(30)),
        };
        assert_eq!(
            authorization_value(&spec, &signing_credential(), 1_800_000_000, &"C".repeat(22))
                .unwrap(),
            "PiHub-HMAC-SHA256 dev_AAAAAAAAAAAAAAAAAAAAAA:1800000000:CCCCCCCCCCCCCCCCCCCCCC:GGGGGGGGGGGGGGGGGGGGGG:omu6JdCYA72o1I6Qmue5Hs_gtlj6b0X9SKnsR1bP0k4"
        );
    }

    #[test]
    fn v3_get_vector_uses_empty_digest_without_a_digest_header() {
        let spec = AuthenticatedRequestSpec::empty(
            reqwest::Method::GET,
            url::Url::parse("https://pi.invalid/api/models?b=2&a=1").unwrap(),
            Duration::from_secs(30),
        );
        assert_eq!(
            spec.content_sha256,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            authorization_value(&spec, &signing_credential(), 1_800_000_000, &"C".repeat(22))
                .unwrap(),
            "PiHub-HMAC-SHA256 dev_AAAAAAAAAAAAAAAAAAAAAA:1800000000:CCCCCCCCCCCCCCCCCCCCCC:GGGGGGGGGGGGGGGGGGGGGG:imupS27RgiPWF127hc06srPcNQkz8r1h7GQsTEWvo-A"
        );
        let request = authenticated_request(&reqwest::Client::new(), &spec, &signing_credential())
            .unwrap()
            .build()
            .unwrap();
        assert!(!request.headers().contains_key(PIHUB_CONTENT_SHA256_HEADER));
    }

    #[test]
    fn multipart_signature_binds_the_exact_binary_wire_body() {
        let files = vec![
            UploadFileIn {
                name: "a-b.bin".into(),
                data: "AP8B".into(),
            },
            UploadFileIn {
                name: "你好.txt".into(),
                data: "aGVsbG8K".into(),
            },
        ];
        let boundary = "pihub-test-boundary";
        let body = multipart_upload_body(&files, boundary).unwrap();
        assert_eq!(body.len(), 303);
        let endpoint = url::Url::parse(
            "https://device.example.ts.net:30141/api/files/project?type=upload&conflict=overwrite",
        )
        .unwrap();
        let spec = AuthenticatedRequestSpec::bytes(
            reqwest::Method::POST,
            endpoint,
            body.clone(),
            format!("multipart/form-data; boundary={boundary}"),
            Duration::from_secs(300),
        );
        assert_eq!(
            spec.content_sha256,
            "172f337437cd679ced2040674f5285933dbab1c91844d722b507c4100f45cf4e"
        );
        assert_eq!(
            authorization_value(&spec, &signing_credential(), 1_800_000_000, &"C".repeat(22))
                .unwrap(),
            "PiHub-HMAC-SHA256 dev_AAAAAAAAAAAAAAAAAAAAAA:1800000000:CCCCCCCCCCCCCCCCCCCCCC:GGGGGGGGGGGGGGGGGGGGGG:dTXpu2BuFUt2crgPjYvs3fbOoMrpxL4M_HHF6uXNqUY"
        );

        let request = authenticated_request(&reqwest::Client::new(), &spec, &signing_credential())
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            request.headers()[PIHUB_CONTENT_SHA256_HEADER],
            spec.content_sha256
        );
        assert_eq!(
            request.body().and_then(reqwest::Body::as_bytes),
            Some(body.as_ref())
        );

        let mut tampered = body.to_vec();
        tampered[150] ^= 1;
        let tampered_spec = AuthenticatedRequestSpec::bytes(
            reqwest::Method::POST,
            spec.endpoint.clone(),
            Bytes::from(tampered),
            spec.content_type.clone().unwrap(),
            Duration::from_secs(300),
        );
        assert_ne!(tampered_spec.content_sha256, spec.content_sha256);
        assert_ne!(
            authorization_value(
                &tampered_spec,
                &signing_credential(),
                1_800_000_000,
                &"C".repeat(22),
            )
            .unwrap(),
            authorization_value(&spec, &signing_credential(), 1_800_000_000, &"C".repeat(22))
                .unwrap()
        );
    }

    #[test]
    fn protected_mutations_always_send_a_wire_digest() {
        let endpoint =
            url::Url::parse("https://device.example.ts.net:30141/api/agent/new").unwrap();
        let post = AuthenticatedRequestSpec::empty(
            reqwest::Method::POST,
            endpoint.clone(),
            Duration::from_secs(30),
        );
        let post = authenticated_request(&reqwest::Client::new(), &post, &signing_credential())
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            post.headers()[PIHUB_CONTENT_SHA256_HEADER],
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );

        let get = AuthenticatedRequestSpec::empty(
            reqwest::Method::GET,
            endpoint,
            Duration::from_secs(30),
        );
        let get = authenticated_request(&reqwest::Client::new(), &get, &signing_credential())
            .unwrap()
            .build()
            .unwrap();
        assert!(!get.headers().contains_key(PIHUB_CONTENT_SHA256_HEADER));
    }

    #[test]
    fn authentication_metadata_requires_exact_protocol_and_bounded_clock() {
        let valid = AuthenticationMetadata {
            scheme: PIHUB_AUTH_SCHEME.into(),
            signing_context: PIHUB_SIGNING_CONTEXT.into(),
            epoch: "E".repeat(22),
            server_time_unix_seconds: 1_800_000_002,
            timestamp_window_seconds: 120,
        };
        assert_eq!(
            validate_authentication_metadata(&valid, 1_800_000_000, 1_800_000_002).unwrap(),
            1
        );
        let mut wrong_context = valid.clone();
        wrong_context.signing_context = "pihub-request-v2".into();
        assert!(
            validate_authentication_metadata(&wrong_context, 1_800_000_000, 1_800_000_002).is_err()
        );
        let mut excessive_offset = valid;
        excessive_offset.server_time_unix_seconds += MAX_CLOCK_OFFSET_SECONDS + 2;
        assert!(
            validate_authentication_metadata(&excessive_offset, 1_800_000_000, 1_800_000_002)
                .is_err()
        );
    }

    #[test]
    fn credential_status_never_serializes_secret_material() {
        let status = CredentialStatus {
            paired: true,
            device_id: Some("dev_AAAAAAAAAAAAAAAAAAAAAA".into()),
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({
                "paired": true,
                "deviceId": "dev_AAAAAAAAAAAAAAAAAAAAAA"
            })
        );
    }

    fn sample_device(id: &str, host: &str, url: &str) -> Device {
        Device {
            id: id.into(),
            name: "测试设备".into(),
            host: host.into(),
            url: url.into(),
            source: "manual".into(),
            favorite: false,
            accent: "#64a9ff".into(),
            os: Some("linux".into()),
        }
    }

    fn device_test_directory(label: &str) -> PathBuf {
        let mut random = [0u8; 12];
        getrandom::fill(&mut random).unwrap();
        std::env::temp_dir().join(format!(
            "pihub-device-test-{label}-{}-{}",
            std::process::id(),
            URL_SAFE_NO_PAD.encode(random)
        ))
    }

    #[test]
    fn desktop_identity_is_isolated_from_the_legacy_021_install() {
        assert_eq!(
            PIHUB_DESKTOP_BUNDLE_IDENTIFIER,
            "io.github.yourchaingod.pihub.desktop"
        );
        assert_eq!(LEGACY_DESKTOP_BUNDLE_IDENTIFIER, "dev.pihub.desktop");
        assert_eq!(
            PIHUB_KEYRING_SERVICE,
            "io.github.yourchaingod.pihub.desktop.auth.v1"
        );
        assert_eq!(LEGACY_DESKTOP_KEYRING_SERVICE, "com.pihub.desktop.auth.v1");
        assert_ne!(
            PIHUB_DESKTOP_BUNDLE_IDENTIFIER,
            LEGACY_DESKTOP_BUNDLE_IDENTIFIER
        );
        assert_ne!(PIHUB_KEYRING_SERVICE, LEGACY_DESKTOP_KEYRING_SERVICE);
    }

    #[test]
    fn legacy_device_import_is_explicit_read_only_and_keeps_a_private_backup() {
        let root = device_test_directory("legacy-import");
        let current_directory = root.join(PIHUB_DESKTOP_BUNDLE_IDENTIFIER);
        let legacy_directory = root.join(LEGACY_DESKTOP_BUNDLE_IDENTIFIER);
        ensure_private_directory(&current_directory).unwrap();
        ensure_private_directory(&legacy_directory).unwrap();
        let current_path = current_directory.join("devices.json");
        let legacy_path = legacy_directory.join("devices.json");
        assert_eq!(
            legacy_devices_path_from_config_directory(&current_directory).unwrap(),
            legacy_path
        );

        let current = sample_device(
            "device-current",
            "current.example.ts.net",
            "https://current.example.ts.net:30141",
        );
        write_devices_file(&current_path, std::slice::from_ref(&current)).unwrap();
        let conflicting_id = sample_device(
            "device-current",
            "other.example.ts.net",
            "https://other.example.ts.net:30141",
        );
        let conflicting_origin = sample_device(
            "device-same-origin",
            "current.example.ts.net",
            "https://current.example.ts.net:30141",
        );
        let imported = sample_device(
            "device-imported",
            "imported.example.ts.net",
            "https://imported.example.ts.net:30141",
        );
        write_devices_file(
            &legacy_path,
            &[conflicting_id, conflicting_origin, imported.clone()],
        )
        .unwrap();
        let legacy_bytes = fs::read(&legacy_path).unwrap();
        #[cfg(unix)]
        {
            fs::set_permissions(&legacy_path, fs::Permissions::from_mode(0o640)).unwrap();
        }

        let result = import_legacy_device_metadata_paths(&current_path, &legacy_path).unwrap();
        assert_eq!(result.imported, 1);
        assert_eq!(result.skipped, 2);
        assert!(!result.credentials_migrated);
        assert_eq!(result.devices, vec![current.clone(), imported]);
        assert_eq!(fs::read(&legacy_path).unwrap(), legacy_bytes);
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&legacy_path).unwrap().permissions().mode() & 0o777,
            0o640
        );

        let backup = result
            .backup
            .expect("an import must retain a pre-import backup");
        assert!(backup.starts_with("devices.before-legacy-import-"));
        assert_eq!(
            read_devices_file(&current_directory.join(backup)).unwrap(),
            vec![current]
        );
        assert_eq!(read_devices_file(&current_path).unwrap(), result.devices);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn device_store_roundtrip_is_atomic_strict_and_private() {
        let directory = device_test_directory("roundtrip");
        ensure_private_directory(&directory).unwrap();
        let path = directory.join("devices.json");
        let first = sample_device(
            "device-alpha",
            "alpha.example.ts.net:30141",
            "https://alpha.example.ts.net:30141",
        );
        write_devices_file(&path, std::slice::from_ref(&first)).unwrap();
        assert_eq!(read_devices_file(&path).unwrap(), vec![first]);

        let second = sample_device(
            "device-beta",
            "beta.example.ts.net",
            "https://beta.example.ts.net:30141",
        );
        write_devices_file(&path, std::slice::from_ref(&second)).unwrap();
        assert_eq!(read_devices_file(&path).unwrap(), vec![second]);
        assert!(fs::read_dir(&directory).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn device_store_applies_current_user_only_windows_acl() {
        use windows_sys::Win32::Security::{CONTAINER_INHERIT_ACE, OBJECT_INHERIT_ACE};

        fn assert_private_acl(path: &Path, expected_inheritance: u32) {
            use windows_sys::Win32::{
                Foundation::LocalFree,
                Security::{
                    Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT},
                    EqualSid, GetAce, ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION,
                },
                Storage::FileSystem::FILE_ALL_ACCESS,
            };

            let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let mut acl: *mut ACL = std::ptr::null_mut();
            let mut descriptor = std::ptr::null_mut();
            let status = unsafe {
                GetNamedSecurityInfoW(
                    wide_path.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut acl,
                    std::ptr::null_mut(),
                    &mut descriptor,
                )
            };
            assert_eq!(status, 0);
            assert!(!acl.is_null());
            assert_eq!(unsafe { (*acl).AceCount }, 1);
            let mut raw_ace = std::ptr::null_mut();
            assert_ne!(unsafe { GetAce(acl, 0, &mut raw_ace) }, 0);
            let ace = unsafe { &*(raw_ace.cast::<ACCESS_ALLOWED_ACE>()) };
            assert_eq!(ace.Header.AceType, 0);
            assert_eq!(ace.Mask, FILE_ALL_ACCESS);
            assert_eq!(
                u32::from(ace.Header.AceFlags) & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE),
                expected_inheritance
            );
            let current_sid = current_windows_user_sid().unwrap();
            let ace_sid = std::ptr::addr_of!(ace.SidStart).cast_mut().cast();
            assert_ne!(
                unsafe { EqualSid(ace_sid, current_sid.as_ptr().cast_mut().cast()) },
                0
            );
            unsafe {
                LocalFree(descriptor);
            }
        }

        let directory = device_test_directory("windows-acl");
        ensure_private_directory(&directory).unwrap();
        let path = directory.join("devices.json");
        write_devices_file(&path, &[]).unwrap();
        assert_private_acl(&directory, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE);
        assert_private_acl(&path, 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn device_store_rejects_unknown_fields_duplicates_and_oversize() {
        let unknown = serde_json::json!({
            "id": "device-alpha",
            "name": "Alpha",
            "host": "alpha.example.ts.net",
            "url": "https://alpha.example.ts.net:30141",
            "source": "manual",
            "favorite": false,
            "accent": "#64a9ff",
            "unexpected": "secret"
        });
        assert!(serde_json::from_value::<Device>(unknown).is_err());

        let duplicate = sample_device(
            "device-alpha",
            "alpha.example.ts.net",
            "https://alpha.example.ts.net:30141",
        );
        assert!(validate_device_list(&[duplicate.clone(), duplicate]).is_err());

        let directory = device_test_directory("oversize");
        ensure_private_directory(&directory).unwrap();
        let path = directory.join("devices.json");
        let file = fs::File::create(&path).unwrap();
        file.set_len((MAX_DEVICES_FILE_BYTES + 1) as u64).unwrap();
        assert!(read_devices_file(&path).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn device_store_rejects_symlink_file() {
        use std::os::unix::fs::symlink;

        let directory = device_test_directory("symlink");
        ensure_private_directory(&directory).unwrap();
        let target = directory.join("target.json");
        fs::write(&target, "[]").unwrap();
        let path = directory.join("devices.json");
        symlink(&target, &path).unwrap();
        assert!(read_devices_file(&path).is_err());
        assert!(write_devices_file(&path, &[]).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn portable_names_and_upload_limits_cover_windows_edge_cases() {
        assert_eq!(portable_download_name("CON.txt"), "_CON.txt");
        let traversal = portable_download_name("../../report.txt");
        assert!(!traversal.contains('/'));
        assert!(!matches!(traversal.as_str(), "." | ".."));
        for name in ["CON", "com1.log", "bad:name", "trail.", "../escape"] {
            assert!(validate_upload_name(name).is_err(), "accepted {name}");
        }
        assert!(validate_upload_name("报告-01.txt").is_ok());
        assert!(multipart_upload_body(&[], "pihub-boundary").is_err());
        assert!(base64_decode("Zh==").is_err());
        assert_eq!(base64_decode("Zg==").unwrap(), b"f");
    }
}
