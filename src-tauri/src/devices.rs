use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
#[cfg(windows)]
use std::os::windows::{
    ffi::OsStrExt as _,
    fs::{MetadataExt as _, OpenOptionsExt as _},
};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};

use crate::transport::{canonical_origin, validate_tailnet_url};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Device {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) host: String,
    pub(crate) url: String,
    pub(crate) source: String,
    pub(crate) favorite: bool,
    pub(crate) accent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) os: Option<String>,
    /// Stable Tailscale CGNAT/IPv6 address — survives machine renames, unlike
    /// the DNS name embedded in host/url.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ip: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyDeviceImportResult {
    devices: Vec<Device>,
    imported: usize,
    skipped: usize,
    backup: Option<String>,
    credentials_migrated: bool,
}
pub(crate) const MAX_DEVICES_FILE_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_DEVICES: usize = 256;
pub(crate) const PIHUB_DESKTOP_BUNDLE_IDENTIFIER: &str = "io.github.yourchaingod.pihub.desktop";
pub(crate) const LEGACY_DESKTOP_BUNDLE_IDENTIFIER: &str = "dev.pihub.desktop";
pub(crate) fn device_store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) fn metadata_is_link_like(metadata: &fs::Metadata) -> bool {
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
pub(crate) fn windows_error(context: &str, code: u32) -> String {
    format!(
        "{context}：{}",
        std::io::Error::from_raw_os_error(code as i32)
    )
}

#[cfg(windows)]
pub(crate) fn aligned_windows_buffer(bytes: usize) -> Vec<usize> {
    vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())]
}

#[cfg(windows)]
pub(crate) fn current_windows_user_sid() -> Result<Vec<usize>, String> {
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
pub(crate) fn current_user_only_acl(inherit_to_children: bool) -> Result<Vec<usize>, String> {
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
pub(crate) fn tighten_private_windows_path(
    path: &Path,
    inherit_to_children: bool,
) -> Result<(), String> {
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

pub(crate) fn tighten_private_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("无法收紧设备配置目录权限：{error}"))?;
    #[cfg(windows)]
    tighten_private_windows_path(path, true)?;
    Ok(())
}

pub(crate) fn tighten_private_file(file: &fs::File, path: &Path) -> Result<(), String> {
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

pub(crate) fn ensure_private_directory(path: &Path) -> Result<(), String> {
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

pub(crate) fn devices_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    ensure_private_directory(&dir)?;
    Ok(dir.join("devices.json"))
}

pub(crate) fn validate_device(device: &Device) -> Result<(), String> {
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
    if let Some(ip) = device.ip.as_deref() {
        let parsed = ip
            .parse::<std::net::IpAddr>()
            .map_err(|_| "设备 Tailscale IP 无效".to_owned())?;
        if !crate::transport::is_tailscale_ip(parsed) {
            return Err("设备 Tailscale IP 无效".into());
        }
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

pub(crate) fn validate_device_list(devices: &[Device]) -> Result<(), String> {
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

pub(crate) fn open_devices_for_read(
    path: &Path,
    tighten_permissions: bool,
) -> Result<fs::File, String> {
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

pub(crate) fn read_devices_file_with_policy(
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

pub(crate) fn read_devices_file(path: &Path) -> Result<Vec<Device>, String> {
    read_devices_file_with_policy(path, true)
}

pub(crate) fn create_devices_temp(directory: &Path) -> Result<(PathBuf, fs::File), String> {
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

pub(crate) fn write_devices_file(path: &Path, devices: &[Device]) -> Result<(), String> {
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

pub(crate) fn read_devices(app: &AppHandle) -> Result<Vec<Device>, String> {
    read_devices_file(&devices_path(app)?)
}

pub(crate) fn write_devices(app: &AppHandle, devices: &[Device]) -> Result<(), String> {
    write_devices_file(&devices_path(app)?, devices)
}

pub(crate) fn legacy_devices_path_from_config_directory(
    config_directory: &Path,
) -> Result<PathBuf, String> {
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

pub(crate) fn read_legacy_devices_file(path: &Path) -> Result<Vec<Device>, String> {
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

pub(crate) fn merge_legacy_devices(
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

pub(crate) fn create_legacy_import_backup(
    path: &Path,
    devices: &[Device],
) -> Result<String, String> {
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

pub(crate) fn import_legacy_device_metadata_paths(
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
#[tauri::command]
pub(crate) fn list_devices(app: AppHandle) -> Result<Vec<Device>, String> {
    let _guard = device_store_lock().lock().map_err(|_| "设备清单锁不可用")?;
    read_devices(&app)
}

#[tauri::command]
pub(crate) fn import_legacy_device_metadata(
    app: AppHandle,
) -> Result<LegacyDeviceImportResult, String> {
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
pub(crate) fn save_device(app: AppHandle, device: Device) -> Result<Vec<Device>, String> {
    validate_device(&device)?;
    let _guard = device_store_lock().lock().map_err(|_| "设备清单锁不可用")?;
    let mut devices = read_devices(&app)?;
    devices.retain(|item| item.id != device.id);
    devices.push(device);
    write_devices(&app, &devices)?;
    Ok(devices)
}

#[tauri::command]
pub(crate) fn remove_device(app: AppHandle, id: String) -> Result<Vec<Device>, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
            ip: None,
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
}
