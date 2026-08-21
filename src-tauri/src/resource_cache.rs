use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

use crate::{ensure_private_directory, metadata_is_link_like, tighten_private_file};

/// Generic resource cache for slash commands, extensions, session lists, etc.
/// Desktop-only: no localStorage quota cliff, data survives restarts.
pub(crate) const MAX_RESOURCE_CACHE_BYTES: usize = 2 * 1024 * 1024; // 2MB per resource

fn validate_cache_key(value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
        });
    if valid {
        Ok(())
    } else {
        Err("缓存键格式无效".into())
    }
}

fn resource_cache_file(root: &Path, key: &str) -> Result<PathBuf, String> {
    validate_cache_key(key)?;
    // Flatten device:resource structure into safe filename
    let safe_name = key.replace(':', "-");
    Ok(root.join(format!("{safe_name}.json")))
}

fn read_cache_file(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法检查资源缓存：{error}")),
        Ok(metadata) if metadata_is_link_like(&metadata) || !metadata.is_file() => {
            return Err("资源缓存必须是本机普通文件".into())
        }
        Ok(_) => {}
    }
    let mut file = fs::File::open(path).map_err(|error| format!("无法打开资源缓存：{error}"))?;
    let mut data = Vec::new();
    Read::by_ref(&mut file)
        .take((MAX_RESOURCE_CACHE_BYTES + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|error| format!("无法读取资源缓存：{error}"))?;
    if data.len() > MAX_RESOURCE_CACHE_BYTES {
        return Err("资源缓存超过大小上限".into());
    }
    String::from_utf8(data)
        .map(Some)
        .map_err(|_| "资源缓存不是有效 UTF-8".into())
}

fn write_cache_file(path: &Path, payload: &str) -> Result<(), String> {
    if payload.len() > MAX_RESOURCE_CACHE_BYTES {
        return Err("资源缓存超过大小上限".into());
    }
    let directory = path.parent().ok_or("资源缓存没有父目录")?;
    ensure_private_directory(directory)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法检查现有资源缓存：{error}")),
        Ok(metadata) if metadata_is_link_like(&metadata) || !metadata.is_file() => {
            return Err("现有资源缓存不是本机普通文件".into())
        }
        Ok(_) => {}
    }
    let mut temporary_path = None;
    let mut temporary = None;
    for _ in 0..8 {
        let mut random = [0u8; 12];
        getrandom::fill(&mut random)
            .map_err(|_| "无法生成资源缓存临时文件名".to_owned())?;
        let candidate = directory.join(format!(".resource-{}.tmp", URL_SAFE_NO_PAD.encode(random)));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        match options.open(&candidate) {
            Ok(file) => {
                temporary_path = Some(candidate);
                temporary = Some(file);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建资源缓存临时文件：{error}")),
        }
    }
    let (temporary_path, mut temporary) = match (temporary_path, temporary) {
        (Some(path), Some(file)) => (path, file),
        _ => return Err("无法分配资源缓存临时文件".into()),
    };
    if let Err(error) = tighten_private_file(&temporary, &temporary_path) {
        drop(temporary);
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    let written = temporary
        .write_all(payload.as_bytes())
        .and_then(|_| temporary.sync_all())
        .map_err(|error| format!("无法写入资源缓存：{error}"));
    if let Err(error) = written {
        drop(temporary);
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    drop(temporary);
    if let Err(error) = fs::rename(&temporary_path, path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!("无法发布资源缓存：{error}"));
    }
    Ok(())
}

fn delete_cache_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法检查资源缓存：{error}")),
        Ok(metadata) if metadata_is_link_like(&metadata) || !metadata.is_file() => {
            Err("资源缓存必须是本机普通文件".into())
        }
        Ok(_) => fs::remove_file(path).map_err(|error| format!("无法删除资源缓存：{error}")),
    }
}

fn resource_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let config = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let root = config.join("resource-cache");
    ensure_private_directory(&root)?;
    Ok(root)
}

#[tauri::command]
pub(crate) fn read_resource_cache(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let path = resource_cache_file(&resource_cache_root(&app)?, &key)?;
    read_cache_file(&path)
}

#[tauri::command]
pub(crate) fn write_resource_cache(
    app: AppHandle,
    key: String,
    payload: String,
) -> Result<(), String> {
    let path = resource_cache_file(&resource_cache_root(&app)?, &key)?;
    write_cache_file(&path, &payload)
}

#[tauri::command]
pub(crate) fn delete_resource_cache(app: AppHandle, key: String) -> Result<(), String> {
    let path = resource_cache_file(&resource_cache_root(&app)?, &key)?;
    delete_cache_file(&path)
}

#[tauri::command]
pub(crate) fn clear_resource_cache(app: AppHandle) -> Result<(), String> {
    let root = resource_cache_root(&app)?;
    for entry in fs::read_dir(&root).map_err(|error| format!("无法列出资源缓存：{error}"))? {
        let entry = entry.map_err(|error| format!("无法列出资源缓存：{error}"))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}
