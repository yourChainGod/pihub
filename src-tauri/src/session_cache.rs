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

/// Session transcripts are append-only on the server; the desktop persists
/// every opened session in full so reopening is an incremental top-up. The
/// cache lives in plain files (one folder per device, one JSON per session)
/// instead of web storage, which both removes the ~5MB localStorage quota
/// cliff and keeps the data inspectable per device.

fn validate_cache_segment(value: &str, label: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if valid {
        Ok(())
    } else {
        Err(format!("{label}格式无效"))
    }
}

fn session_cache_file(root: &Path, device_id: &str, session_id: &str) -> Result<PathBuf, String> {
    validate_cache_segment(device_id, "设备 ID")?;
    validate_cache_segment(session_id, "会话 ID")?;
    Ok(root.join(device_id).join(format!("{session_id}.json")))
}

fn read_cache_file(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法检查会话缓存：{error}")),
        Ok(metadata) if metadata_is_link_like(&metadata) || !metadata.is_file() => {
            return Err("会话缓存必须是本机普通文件".into())
        }
        Ok(_) => {}
    }
    let mut file = fs::File::open(path).map_err(|error| format!("无法打开会话缓存：{error}"))?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)
        .map_err(|error| format!("无法读取会话缓存：{error}"))?;
    String::from_utf8(data)
        .map(Some)
        .map_err(|_| "会话缓存不是有效 UTF-8".into())
}

fn write_cache_file(path: &Path, payload: &str) -> Result<(), String> {
    let directory = path.parent().ok_or("会话缓存没有父目录")?;
    ensure_private_directory(directory)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法检查现有会话缓存：{error}")),
        Ok(metadata) if metadata_is_link_like(&metadata) || !metadata.is_file() => {
            return Err("现有会话缓存不是本机普通文件".into())
        }
        Ok(_) => {}
    }
    let mut temporary_path = None;
    let mut temporary = None;
    for _ in 0..8 {
        let mut random = [0u8; 12];
        getrandom::fill(&mut random).map_err(|_| "无法生成会话缓存临时文件名".to_owned())?;
        let candidate = directory.join(format!(".session-{}.tmp", URL_SAFE_NO_PAD.encode(random)));
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
            Err(error) => return Err(format!("无法创建会话缓存临时文件：{error}")),
        }
    }
    let (temporary_path, mut temporary) = match (temporary_path, temporary) {
        (Some(path), Some(file)) => (path, file),
        _ => return Err("无法分配会话缓存临时文件".into()),
    };
    if let Err(error) = tighten_private_file(&temporary, &temporary_path) {
        drop(temporary);
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    let written = temporary
        .write_all(payload.as_bytes())
        .and_then(|_| temporary.sync_all())
        .map_err(|error| format!("无法写入会话缓存：{error}"));
    if let Err(error) = written {
        drop(temporary);
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    drop(temporary);
    if let Err(error) = fs::rename(&temporary_path, path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!("无法发布会话缓存：{error}"));
    }
    Ok(())
}

fn delete_cache_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法检查会话缓存：{error}")),
        Ok(metadata) if metadata_is_link_like(&metadata) || !metadata.is_file() => {
            Err("会话缓存必须是本机普通文件".into())
        }
        Ok(_) => fs::remove_file(path).map_err(|error| format!("无法删除会话缓存：{error}")),
    }
}

fn session_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let config = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let root = config.join("session-cache");
    ensure_private_directory(&root)?;
    Ok(root)
}

#[tauri::command]
pub(crate) fn read_session_cache(
    app: AppHandle,
    device_id: String,
    session_id: String,
) -> Result<Option<String>, String> {
    let path = session_cache_file(&session_cache_root(&app)?, &device_id, &session_id)?;
    read_cache_file(&path)
}

#[tauri::command]
pub(crate) fn write_session_cache(
    app: AppHandle,
    device_id: String,
    session_id: String,
    payload: String,
) -> Result<(), String> {
    let root = session_cache_root(&app)?;
    let path = session_cache_file(&root, &device_id, &session_id)?;
    write_cache_file(&path, &payload)
}

#[tauri::command]
pub(crate) fn delete_session_cache(
    app: AppHandle,
    device_id: String,
    session_id: String,
) -> Result<(), String> {
    let path = session_cache_file(&session_cache_root(&app)?, &device_id, &session_id)?;
    delete_cache_file(&path)
}

#[tauri::command]
pub(crate) fn clear_session_cache(app: AppHandle) -> Result<(), String> {
    let root = session_cache_root(&app)?;
    for entry in fs::read_dir(&root).map_err(|error| format!("无法列出会话缓存：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法列出会话缓存：{error}"))?;
        let metadata = entry
            .metadata()
            .map_err(|error| format!("无法检查会话缓存：{error}"))?;
        if metadata.is_dir() && !metadata_is_link_like(&metadata) {
            fs::remove_dir_all(entry.path())
                .map_err(|error| format!("无法清空会话缓存：{error}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_test_root(label: &str) -> PathBuf {
        let mut random = [0u8; 12];
        getrandom::fill(&mut random).unwrap();
        std::env::temp_dir().join(format!(
            "pihub-session-cache-test-{label}-{}-{}",
            std::process::id(),
            URL_SAFE_NO_PAD.encode(random)
        ))
    }

    #[test]
    fn cache_segments_reject_traversal_and_control_characters() {
        let root = PathBuf::from("/tmp/pihub-cache");
        assert!(session_cache_file(&root, "device-1", "session-1").is_ok());
        for bad in [
            "", "..", "../etc", "a/b", "a\\b", ".hidden", "a\nb", "device:1",
        ] {
            assert!(
                session_cache_file(&root, bad, "session-1").is_err(),
                "{bad}"
            );
            assert!(session_cache_file(&root, "device-1", bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn write_read_delete_roundtrip_is_atomic_and_private() {
        let root = cache_test_root("roundtrip");
        let path = session_cache_file(&root, "device-1", "session-1").unwrap();
        write_cache_file(&path, "{\"v\":1}").unwrap();
        write_cache_file(&path, "{\"v\":2}").unwrap();
        assert_eq!(
            read_cache_file(&path).unwrap().as_deref(),
            Some("{\"v\":2}")
        );
        assert!(fs::read_dir(path.parent().unwrap())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        delete_cache_file(&path).unwrap();
        assert_eq!(read_cache_file(&path).unwrap(), None);
        delete_cache_file(&path).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cache_rejects_symlink_files() {
        use std::os::unix::fs::symlink;

        let root = cache_test_root("symlink");
        let path = session_cache_file(&root, "device-1", "session-1").unwrap();
        write_cache_file(&path, "{}").unwrap();
        let link = session_cache_file(&root, "device-1", "session-2").unwrap();
        symlink(&path, &link).unwrap();
        assert!(read_cache_file(&link).is_err());
        assert!(write_cache_file(&link, "{}").is_err());
        assert!(delete_cache_file(&link).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
