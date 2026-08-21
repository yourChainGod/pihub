use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::transport::{
    response_bytes_limited_named, send_authenticated, validate_tailnet_url, validated_api_endpoint,
    ApiAccess, AuthenticatedRequestSpec, MAX_AUTH_RESPONSE_BYTES,
};
use crate::util::base64_decode;

pub(crate) const MAX_SESSION_EXPORT_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_TEXT_DOWNLOAD_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_REMOTE_DOWNLOAD_BYTES: usize = 512 * 1024 * 1024;
pub(crate) const MAX_UPLOAD_FILE_BYTES: usize = 256 * 1024 * 1024;
pub(crate) const MAX_UPLOAD_TOTAL_BYTES: usize = 1024 * 1024 * 1024;
pub(crate) const MAX_UPLOAD_FILES: usize = 64;
pub(crate) const MAX_UPLOAD_CHUNK_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_CONCURRENT_CHUNK_UPLOADS: usize = 16;
#[derive(Debug, Serialize)]
pub(crate) struct ExportResult {
    path: String,
}

#[tauri::command]
pub(crate) async fn export_session_html(
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

pub(crate) fn portable_download_name(name: &str) -> String {
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

pub(crate) fn reserve_download_path(
    app: &AppHandle,
    name: &str,
) -> Result<(PathBuf, fs::File), String> {
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

pub(crate) fn remove_partial_download(path: &Path) {
    let _ = fs::remove_file(path);
}

pub(crate) fn write_reserved_download(
    path: &Path,
    mut file: fs::File,
    bytes: &[u8],
) -> Result<(), String> {
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        remove_partial_download(path);
        return Err(format!("无法写入下载文件：{error}"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn save_text_download(
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
pub(crate) async fn download_remote_file(
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
#[derive(Debug, Deserialize)]
pub(crate) struct UploadFileIn {
    pub(crate) name: String,
    pub(crate) data: String,
}

pub(crate) fn validate_upload_name(name: &str) -> Result<(), String> {
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

pub(crate) fn validate_upload_boundary(boundary: &str) -> Result<(), String> {
    if boundary.is_empty()
        || boundary.len() > 70
        || !boundary
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("文件上传边界无效".into());
    }
    Ok(())
}

pub(crate) fn multipart_upload_body(
    files: &[UploadFileIn],
    boundary: &str,
) -> Result<Bytes, String> {
    validate_upload_boundary(boundary)?;
    if files.is_empty() || files.len() > MAX_UPLOAD_FILES {
        return Err("每次必须上传 1 至 64 个文件".into());
    }
    let mut body = Vec::new();
    let mut decoded_total = 0usize;
    for file in files {
        validate_upload_name(&file.name)?;
        if file.data.len() > MAX_UPLOAD_FILE_BYTES.div_ceil(3) * 4 {
            return Err(format!("上传文件 {} 超过 256MB 上限", file.name));
        }
        let decoded = base64_decode(&file.data)?;
        if decoded.len() > MAX_UPLOAD_FILE_BYTES {
            return Err(format!("上传文件 {} 超过 256MB 上限", file.name));
        }
        decoded_total = decoded_total
            .checked_add(decoded.len())
            .ok_or_else(|| "上传文件总大小溢出".to_owned())?;
        if decoded_total > MAX_UPLOAD_TOTAL_BYTES {
            return Err("单次上传总大小超过 1GB 上限".into());
        }
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{}\"\r\nContent-Type: application/octet-stream\r\n\r\n", file.name).as_bytes());
        body.extend_from_slice(&decoded);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok(Bytes::from(body))
}

async fn send_upload_body(
    base: &url::Url,
    endpoint: url::Url,
    body: Bytes,
    boundary: &str,
) -> Result<Value, String> {
    let spec = AuthenticatedRequestSpec::bytes(
        reqwest::Method::POST,
        endpoint,
        body,
        format!("multipart/form-data; boundary={boundary}"),
        Duration::from_secs(300),
    );
    let response = send_authenticated(base, &spec).await?;
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

/// Multipart upload to the pi-web files API. The webview sends each file as
/// base64 (invoke payloads are JSON); we rebuild the bytes here so binaries
/// survive intact. Mirrors the web FileExplorer's `type=upload` contract.
#[tauri::command]
pub(crate) async fn upload_remote_files(
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
    send_upload_body(&base, endpoint, body, &boundary).await
}

#[derive(Default)]
struct ChunkUploadFile {
    next_index: u64,
    bytes: usize,
}

struct ChunkUpload {
    directory: PathBuf,
    files: HashMap<String, ChunkUploadFile>,
    bytes: usize,
}

fn chunk_uploads() -> &'static Mutex<HashMap<String, ChunkUpload>> {
    static UPLOADS: OnceLock<Mutex<HashMap<String, ChunkUpload>>> = OnceLock::new();
    UPLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn validate_upload_id(upload_id: &str) -> Result<(), String> {
    if !(8..=64).contains(&upload_id.len())
        || !upload_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("上传标识无效".into());
    }
    Ok(())
}

fn chunk_upload_root() -> Result<PathBuf, String> {
    let root = std::env::temp_dir().join("pihub-uploads");
    crate::devices::ensure_private_directory(&root)?;
    Ok(root)
}

/// Stages one base64 chunk of a chunked upload into a private temp file.
/// Chunks must arrive in order; the frontend sends 8MB slices so no single
/// IPC message has to carry the whole (base64-inflated) file.
#[tauri::command]
pub(crate) fn upload_remote_chunk(
    url: String,
    upload_id: String,
    name: String,
    index: u64,
    data: String,
) -> Result<(), String> {
    validate_tailnet_url(&url)?;
    validate_upload_id(&upload_id)?;
    validate_upload_name(&name)?;
    if data.len() > MAX_UPLOAD_CHUNK_BYTES.div_ceil(3) * 4 {
        return Err("上传分块超过 16MB 上限".into());
    }
    let decoded = base64_decode(&data)?;
    if decoded.len() > MAX_UPLOAD_CHUNK_BYTES {
        return Err("上传分块超过 16MB 上限".into());
    }
    let mut uploads = chunk_uploads().lock().map_err(|_| "上传暂存状态不可用")?;
    let concurrent = uploads.len();
    let staging = match uploads.entry(upload_id.clone()) {
        Entry::Occupied(entry) => entry.into_mut(),
        Entry::Vacant(entry) => {
            if concurrent >= MAX_CONCURRENT_CHUNK_UPLOADS {
                return Err("同时进行的分块上传过多".into());
            }
            let directory = chunk_upload_root()?.join(&upload_id);
            crate::devices::ensure_private_directory(&directory)?;
            entry.insert(ChunkUpload {
                directory,
                files: HashMap::new(),
                bytes: 0,
            })
        }
    };
    if !staging.files.contains_key(&name) && staging.files.len() >= MAX_UPLOAD_FILES {
        return Err("每次必须上传 1 至 64 个文件".into());
    }
    let file_state = staging.files.entry(name.clone()).or_default();
    if index != file_state.next_index {
        return Err("上传分块顺序无效".into());
    }
    if file_state.bytes + decoded.len() > MAX_UPLOAD_FILE_BYTES {
        return Err(format!("上传文件 {name} 超过 256MB 上限"));
    }
    if staging.bytes + decoded.len() > MAX_UPLOAD_TOTAL_BYTES {
        return Err("单次上传总大小超过 1GB 上限".into());
    }
    let path = staging.directory.join(&name);
    let mut options = fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&path)
        .map_err(|error| format!("无法写入上传暂存文件：{error}"))?;
    if file_state.next_index == 0 {
        crate::devices::tighten_private_file(&file, &path)?;
    }
    file.write_all(&decoded)
        .map_err(|error| format!("无法写入上传暂存文件：{error}"))?;
    file_state.next_index += 1;
    file_state.bytes += decoded.len();
    staging.bytes += decoded.len();
    Ok(())
}

fn multipart_upload_body_from_staging(
    staging: &ChunkUpload,
    names: &[String],
    boundary: &str,
) -> Result<Bytes, String> {
    validate_upload_boundary(boundary)?;
    if names.is_empty() || names.len() > MAX_UPLOAD_FILES {
        return Err("每次必须上传 1 至 64 个文件".into());
    }
    let mut body = Vec::new();
    let mut total = 0usize;
    for name in names {
        validate_upload_name(name)?;
        let state = staging
            .files
            .get(name)
            .ok_or_else(|| format!("上传文件 {name} 缺少暂存数据"))?;
        let data = fs::read(staging.directory.join(name))
            .map_err(|error| format!("无法读取上传暂存文件：{error}"))?;
        if data.len() != state.bytes || data.len() > MAX_UPLOAD_FILE_BYTES {
            return Err(format!("上传暂存文件 {name} 不完整"));
        }
        total = total
            .checked_add(data.len())
            .ok_or_else(|| "上传文件总大小溢出".to_owned())?;
        if total > MAX_UPLOAD_TOTAL_BYTES {
            return Err("单次上传总大小超过 1GB 上限".into());
        }
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{}\"\r\nContent-Type: application/octet-stream\r\n\r\n", name).as_bytes());
        body.extend_from_slice(&data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok(Bytes::from(body))
}

fn remove_chunk_upload(staging: &ChunkUpload) {
    let _ = fs::remove_dir_all(&staging.directory);
}

/// Sends a previously chunked upload. The multipart body is rebuilt from the
/// staged temp files; the staging directory is removed on every outcome.
#[tauri::command]
pub(crate) async fn upload_remote_commit(
    url: String,
    path: String,
    upload_id: String,
    names: Vec<String>,
) -> Result<Value, String> {
    let base = validate_tailnet_url(&url)?;
    let endpoint = validated_api_endpoint(&base, &path, ApiAccess::FileUpload)?;
    validate_upload_id(&upload_id)?;
    let staging = chunk_uploads()
        .lock()
        .map_err(|_| "上传暂存状态不可用")?
        .remove(&upload_id)
        .ok_or_else(|| "上传暂存不存在或已过期".to_owned())?;
    let result = async {
        let mut boundary_random = [0u8; 18];
        getrandom::fill(&mut boundary_random).map_err(|_| "无法生成上传边界随机数".to_owned())?;
        let boundary = format!("pihub-upload-{}", URL_SAFE_NO_PAD.encode(boundary_random));
        let body = multipart_upload_body_from_staging(&staging, &names, &boundary)?;
        send_upload_body(&base, endpoint, body, &boundary).await
    }
    .await;
    remove_chunk_upload(&staging);
    result
}

/// Drops a chunked upload's staging directory (frontend error/cancel path).
#[tauri::command]
pub(crate) fn upload_remote_abort(upload_id: String) -> Result<(), String> {
    validate_upload_id(&upload_id)?;
    let staging = chunk_uploads()
        .lock()
        .map_err(|_| "上传暂存状态不可用")?
        .remove(&upload_id);
    if let Some(staging) = staging {
        remove_chunk_upload(&staging);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::base64_encode;

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

    fn test_upload_id(label: &str) -> String {
        format!("test-{}-{label}", std::process::id())
    }

    fn staged_directory(upload_id: &str) -> PathBuf {
        chunk_uploads()
            .lock()
            .unwrap()
            .get(upload_id)
            .map(|staging| staging.directory.clone())
            .unwrap()
    }

    fn stage_chunks(upload_id: &str, name: &str, data: &[u8], chunk_size: usize) {
        let url = "https://device.example.ts.net:30141".to_owned();
        for (index, chunk) in data.chunks(chunk_size.max(1)).enumerate() {
            upload_remote_chunk(
                url.clone(),
                upload_id.to_owned(),
                name.to_owned(),
                index as u64,
                base64_encode(chunk),
            )
            .unwrap();
        }
        if data.is_empty() {
            upload_remote_chunk(url, upload_id.to_owned(), name.to_owned(), 0, String::new())
                .unwrap();
        }
    }

    #[test]
    fn chunked_upload_reassembles_the_exact_bytes() {
        let upload_id = test_upload_id("reassemble");
        let data: Vec<u8> = (0..100_000u32)
            .map(|value| (value * 31 % 251) as u8)
            .collect();
        stage_chunks(&upload_id, "bin.dat", &data, 33_333);
        let directory = staged_directory(&upload_id);
        assert_eq!(fs::read(directory.join("bin.dat")).unwrap(), data);

        let staging_lock = chunk_uploads().lock().unwrap();
        let staged = staging_lock.get(&upload_id).unwrap();
        let names = vec!["bin.dat".to_owned()];
        let body =
            multipart_upload_body_from_staging(staged, &names, "pihub-test-boundary").unwrap();
        let expected = multipart_upload_body(
            &[UploadFileIn {
                name: "bin.dat".into(),
                data: base64_encode(&data),
            }],
            "pihub-test-boundary",
        )
        .unwrap();
        assert_eq!(body, expected);
        drop(staging_lock);
        upload_remote_abort(upload_id).unwrap();
    }

    #[test]
    fn chunked_upload_rejects_bad_ids_names_base64_and_order() {
        let upload_id = test_upload_id("reject");
        let url = "https://device.example.ts.net:30141".to_owned();
        for bad_id in ["short", &"a".repeat(65), "has space!", "..\\..", "slash/id"] {
            assert!(
                upload_remote_chunk(url.clone(), bad_id.into(), "a.txt".into(), 0, String::new())
                    .is_err(),
                "accepted {bad_id}"
            );
        }
        for bad_name in ["../escape", "bad:name", "CON"] {
            assert!(
                upload_remote_chunk(
                    url.clone(),
                    upload_id.clone(),
                    bad_name.into(),
                    0,
                    String::new()
                )
                .is_err(),
                "accepted {bad_name}"
            );
        }
        assert!(upload_remote_chunk(
            url.clone(),
            upload_id.clone(),
            "a.txt".into(),
            0,
            "!!!!".into()
        )
        .is_err());
        upload_remote_chunk(
            url.clone(),
            upload_id.clone(),
            "a.txt".into(),
            0,
            "Zg==".into(),
        )
        .unwrap();
        assert!(
            upload_remote_chunk(
                url.clone(),
                upload_id.clone(),
                "a.txt".into(),
                0,
                "Zg==".into()
            )
            .is_err(),
            "out-of-order chunk must be rejected"
        );
        upload_remote_chunk(url, upload_id.clone(), "a.txt".into(), 1, "Zg==".into()).unwrap();
        assert_eq!(
            fs::read(staged_directory(&upload_id).join("a.txt")).unwrap(),
            b"ff"
        );
        upload_remote_abort(upload_id).unwrap();
    }

    #[test]
    fn chunk_upload_abort_removes_the_staging_directory() {
        let upload_id = test_upload_id("abort");
        stage_chunks(&upload_id, "a.txt", b"payload", 8);
        let directory = staged_directory(&upload_id);
        assert!(directory.exists());
        upload_remote_abort(upload_id.clone()).unwrap();
        assert!(!directory.exists());
        assert!(chunk_uploads().lock().unwrap().get(&upload_id).is_none());
    }

    #[tokio::test]
    async fn chunk_upload_commit_cleans_staging_even_on_failure() {
        let upload_id = test_upload_id("commit");
        stage_chunks(&upload_id, "a.txt", b"payload", 8);
        let directory = staged_directory(&upload_id);
        // Fails while rebuilding the body (missing staged file) — before any
        // network I/O — and must still drop the staging directory.
        let result = upload_remote_commit(
            "https://device.example.ts.net:30141".into(),
            "/api/files/project?type=upload&conflict=overwrite".into(),
            upload_id.clone(),
            vec!["missing.txt".into()],
        )
        .await;
        assert!(result.is_err());
        assert!(!directory.exists());
        assert!(chunk_uploads().lock().unwrap().get(&upload_id).is_none());
    }
}
