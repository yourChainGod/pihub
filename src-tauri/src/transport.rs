use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use bytes::Bytes;
use hmac::{Hmac, Mac};
use percent_encoding::{AsciiSet, CONTROLS};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::bootstrap;
use crate::credentials::{load_credential, store_credential, StoredCredential};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceStatus {
    pub(crate) state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) latency_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}
pub(crate) const MAX_API_REFERENCE_BYTES: usize = 32 * 1024;
pub(crate) const MAX_API_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_AUTH_RESPONSE_BYTES: usize = 64 * 1024;
pub(crate) const TAILSCALE_STATUS_TIMEOUT: Duration = Duration::from_secs(8);
pub(crate) const MAX_TAILSCALE_STATUS_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const TAILNET_CLIENT_CACHE_CAPACITY: usize = 64;
pub(crate) const TAILNET_CLIENT_CACHE_TTL: Duration = Duration::from_secs(120);
pub(crate) const MAX_CLOCK_OFFSET_SECONDS: i64 = 24 * 60 * 60;
pub(crate) const PIHUB_AUTH_SCHEME: &str = "PiHub-HMAC-SHA256";
pub(crate) const PIHUB_SIGNING_CONTEXT: &str = "pihub-request-v3";
pub(crate) const PIHUB_CONTENT_SHA256_HEADER: &str = "x-pihub-content-sha256";
pub(crate) const PATH_COMPONENT_ENCODE_SET: &AsciiSet = &CONTROLS
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
pub(crate) struct AuthenticationMetadata {
    pub(crate) scheme: String,
    pub(crate) signing_context: String,
    pub(crate) epoch: String,
    pub(crate) server_time_unix_seconds: i64,
    pub(crate) timestamp_window_seconds: u64,
}
#[derive(Clone)]
pub(crate) struct AuthenticatedRequestSpec {
    method: reqwest::Method,
    endpoint: url::Url,
    body: Option<Bytes>,
    content_type: Option<String>,
    accept: Option<&'static str>,
    content_sha256: String,
    timeout: Option<Duration>,
    last_event_id: Option<u64>,
}
pub(crate) fn is_tailscale_ip(ip: IpAddr) -> bool {
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

pub(crate) fn is_tailscale_host(host: &str) -> bool {
    let normalized = host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if normalized.ends_with(".ts.net") {
        return true;
    }
    normalized.parse::<IpAddr>().is_ok_and(is_tailscale_ip)
}

pub(crate) fn validate_percent_encoding(value: &str) -> Result<(), String> {
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

pub(crate) fn decode_safe_path_segment(segment: &str) -> Result<String, String> {
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

pub(crate) fn validate_raw_api_reference(reference: &str) -> Result<(), String> {
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

pub(crate) fn strict_form_component(value: &str) -> Result<String, String> {
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

pub(crate) fn strict_query(endpoint: &url::Url) -> Result<HashMap<String, String>, String> {
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

pub(crate) fn validate_query_shape(
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

pub(crate) fn decoded_api_segments(endpoint: &url::Url) -> Result<Vec<String>, String> {
    endpoint
        .path_segments()
        .ok_or_else(|| "API 地址没有分层路径".to_owned())?
        .map(decode_safe_path_segment)
        .collect()
}

pub(crate) fn validate_generic_api_route(endpoint: &url::Url, method: &str) -> Result<(), String> {
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
                &[
                    "after",
                    "before",
                    "deferThinking",
                    "deferMedia",
                    "desktop",
                    "limit",
                ],
                &[],
            )?;
            for key in ["after", "before"] {
                if let Some(cursor) = query.get(key) {
                    if cursor.is_empty() || cursor.len() > 256 {
                        return Err("会话增量游标无效".into());
                    }
                }
            }
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
        ["api", "git", "diff"] if method == "GET" => {
            validate_query_shape(&query, &["cwd", "path"], &["cwd", "path"])
        }
        ["api", "worktrees"] if method == "GET" => validate_query_shape(&query, &["cwd"], &["cwd"]),
        ["api", "worktrees"] if matches!(method, "POST" | "DELETE") => no_query(&query),
        ["api", "project-trust"] if method == "GET" => {
            validate_query_shape(&query, &["cwd"], &["cwd"])
        }
        ["api", "project-trust"] if method == "POST" => no_query(&query),
        ["api", "skills"] if method == "GET" => validate_query_shape(&query, &["cwd"], &["cwd"]),
        ["api", "skills"] if method == "PATCH" => no_query(&query),
        ["api", "plugins"] if method == "GET" => validate_query_shape(&query, &["cwd"], &["cwd"]),
        ["api", "plugins"] if method == "POST" => no_query(&query),
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
pub(crate) enum ApiAccess<'a> {
    Generic { method: &'a str },
    FileDownload,
    FileUpload,
    SessionExport,
    AgentStream,
    TerminalStream,
}

pub(crate) fn validate_file_api_route(endpoint: &url::Url, upload: bool) -> Result<(), String> {
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

pub(crate) fn validated_api_endpoint(
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
        ApiAccess::TerminalStream => {
            let segments = decoded_api_segments(&endpoint)?;
            if !matches!(segments.iter().map(String::as_str).collect::<Vec<_>>().as_slice(), ["api", "pihub", "terminal", id, "events"] if !id.is_empty())
                || !strict_query(&endpoint)?.is_empty()
            {
                return Err("实时终端地址无效".into());
            }
        }
    }
    Ok(endpoint)
}

pub(crate) fn validate_tailnet_url(value: &str) -> Result<url::Url, String> {
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

pub(crate) async fn tailscale_status() -> Result<Value, String> {
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

pub(crate) fn tailnet_ip_from_status(status: &Value, hostname: &str) -> Option<IpAddr> {
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

pub(crate) async fn tailnet_ip_for_hostname(hostname: &str) -> Result<Option<IpAddr>, String> {
    let wanted = hostname.trim_end_matches('.').to_ascii_lowercase();
    if let Ok(ip) = wanted.parse::<IpAddr>() {
        return Ok(is_tailscale_ip(ip).then_some(ip));
    }
    if !wanted.ends_with(".ts.net") {
        return Ok(None);
    }
    Ok(tailnet_ip_from_status(&tailscale_status().await?, &wanted))
}

pub(crate) fn tailnet_cache_key(base: &url::Url) -> String {
    format!(
        "{}://{}:{}",
        base.scheme(),
        base.host_str().unwrap_or_default(),
        base.port_or_known_default().unwrap_or(443)
    )
}

#[derive(Clone)]
pub(crate) struct TailnetClientCacheEntry {
    client: reqwest::Client,
    created_at: Instant,
    last_used_at: Instant,
}

#[derive(Default)]
pub(crate) struct TailnetClientCache {
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

pub(crate) fn tailnet_clients() -> &'static Mutex<TailnetClientCache> {
    static CLIENTS: OnceLock<Mutex<TailnetClientCache>> = OnceLock::new();
    CLIENTS.get_or_init(|| Mutex::new(TailnetClientCache::default()))
}

/// Drop the cached client for an origin so the next request re-resolves the
/// MagicDNS name via `tailscale status` — Tailscale IPs can change when a
/// device rejoins or switches networks, and a pinned stale IP otherwise
/// breaks the device until the app restarts.
pub(crate) fn invalidate_tailnet_client(base: &url::Url) {
    if let Ok(mut clients) = tailnet_clients().lock() {
        clients.entries.remove(&tailnet_cache_key(base));
    }
}

/// Shared, per-origin cached client: connection-pooled, proxy-free, TCP
/// keepalive for DERP relay hops, MagicDNS pinned to the current Tailscale
/// IP. No total-request timeout here — SSE streams must stay open
/// indefinitely, so callers apply their own per-request timeout instead.
pub(crate) fn cached_tailnet_http_client(
    base: &url::Url,
) -> Result<Option<reqwest::Client>, String> {
    let cache_key = tailnet_cache_key(base);
    let client = tailnet_clients()
        .lock()
        .map_err(|_| "Tailnet HTTP 客户端缓存不可用")?
        .get(&cache_key, Instant::now());
    Ok(client)
}

pub(crate) fn build_tailnet_http_client(
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
        // DERP relays idle-drop TCP without an RST; a short pool idle budget
        // keeps dead relay connections from being reused for the next request.
        .pool_idle_timeout(std::time::Duration::from_secs(60))
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

pub(crate) async fn tailnet_http_client(base: &url::Url) -> Result<reqwest::Client, String> {
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

pub(crate) fn canonical_origin(base: &url::Url) -> String {
    base.origin().ascii_serialization()
}

pub(crate) fn is_base64url(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
pub(crate) fn local_unix_seconds() -> Result<i64, String> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间早于 Unix 纪元，无法安全签名请求".to_owned())?
        .as_secs();
    i64::try_from(seconds).map_err(|_| "系统时间超出签名范围".to_owned())
}

pub(crate) fn validate_authentication_metadata(
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

pub(crate) fn canonical_request_target(endpoint: &url::Url) -> Result<String, String> {
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

pub(crate) fn signing_payload(
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

pub(crate) fn authorization_value(
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

pub(crate) fn authorization_header(
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
    pub(crate) fn empty(method: reqwest::Method, endpoint: url::Url, timeout: Duration) -> Self {
        Self {
            method,
            endpoint,
            body: None,
            content_type: None,
            accept: None,
            content_sha256: hex::encode(Sha256::digest([])),
            timeout: Some(timeout),
            last_event_id: None,
        }
    }

    pub(crate) fn json(
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
            last_event_id: None,
        })
    }

    pub(crate) fn bytes(
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
            last_event_id: None,
        }
    }

    pub(crate) fn accepting(mut self, value: &'static str) -> Self {
        self.accept = Some(value);
        self
    }

    /// SSE reconnects resume the server-side replay ring from this id.
    pub(crate) fn resuming_after(mut self, last_event_id: Option<u64>) -> Self {
        self.last_event_id = last_event_id;
        self
    }

    pub(crate) fn without_timeout(mut self) -> Self {
        self.timeout = None;
        self
    }
}

pub(crate) fn authenticated_request(
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
    if let Some(last_event_id) = spec.last_event_id {
        request = request.header(
            reqwest::header::HeaderName::from_static("last-event-id"),
            reqwest::header::HeaderValue::from(last_event_id),
        );
    }
    if !matches!(spec.method, reqwest::Method::GET | reqwest::Method::HEAD) {
        request = request.header(PIHUB_CONTENT_SHA256_HEADER, &spec.content_sha256);
    }
    if let Some(body) = &spec.body {
        request = request.body(body.clone());
    }
    Ok(request)
}

pub(crate) fn plain_request(
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

pub(crate) async fn send_plain(
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

pub(crate) async fn response_bytes_limited(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<(reqwest::StatusCode, Vec<u8>), String> {
    response_bytes_limited_named(response, max_bytes, "服务端鉴权响应").await
}

pub(crate) async fn response_bytes_limited_named(
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
pub(crate) struct HealthResponse {
    status: String,
    authentication: AuthenticationMetadata,
}

pub(crate) async fn fetch_authentication_metadata(
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

pub(crate) async fn send_authenticated_attempt(
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
        Err(error) => {
            // DERP relays drop idle pooled connections without an RST: a dead
            // connection accepts the write but never answers, surfacing either
            // as a connect error or as the total budget expiring mid-send.
            // GET/HEAD are idempotent, so retry once on a fresh pool; POSTs
            // (prompt etc.) are never auto-retried to avoid double effects.
            let idempotent = matches!(spec.method, reqwest::Method::GET | reqwest::Method::HEAD);
            let retryable = error.is_connect() || (idempotent && error.is_timeout());
            if !retryable {
                return Err(request_error_text(&error));
            }
            invalidate_tailnet_client(base);
            let retry_client = tailnet_http_client(base).await?;
            authenticated_request(&retry_client, spec, credential)?
                .send()
                .await
                .map_err(|error| request_error_text(&error))
        }
    }
}

pub(crate) async fn send_authenticated(
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
/// reqwest's Display hides the underlying cause ("error sending request...").
/// Walk the source chain so the UI can show the real reason (DNS, TLS, refused).
pub(crate) fn request_error_text(error: &reqwest::Error) -> String {
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

pub(crate) async fn inspect_pi_web(_client: &reqwest::Client, base_url: &str) -> DeviceStatus {
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
#[tauri::command]
pub(crate) async fn agegr_request(
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
    let idempotent = request_method == reqwest::Method::GET;
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
    // GETs are idempotent reads: when the body read stalls out (DERP relays
    // drop idle pooled connections without an RST, so a pooled connection can
    // die mid-body), drop the cached client — and its whole pool — and retry
    // once on a fresh connection.
    let response = send_authenticated(&base, &spec).await?;
    let (status, bytes) =
        match response_bytes_limited_named(response, MAX_API_RESPONSE_BYTES, "服务端 API 响应")
            .await
        {
            Ok(done) => done,
            Err(error) if idempotent => {
                invalidate_tailnet_client(&base);
                let retry = send_authenticated(&base, &spec).await?;
                response_bytes_limited_named(retry, MAX_API_RESPONSE_BYTES, "服务端 API 响应")
                    .await
                    .map_err(|_| error)?
            }
            Err(error) => return Err(error),
        };
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
pub(crate) fn tailscale_command() -> Option<bootstrap::LocalExecutable> {
    bootstrap::discover_tailscale_executable()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::PIHUB_CREDENTIAL_VERSION;
    use crate::files::{multipart_upload_body, UploadFileIn};

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
            ("/api/git/diff?cwd=%2Frepo&path=src%2Fa.ts", "GET"),
            ("/api/worktrees?cwd=%2Frepo", "GET"),
            ("/api/worktrees", "POST"),
            ("/api/worktrees", "DELETE"),
            ("/api/project-trust?cwd=%2Frepo", "GET"),
            ("/api/project-trust", "POST"),
            ("/api/skills?cwd=%2Frepo", "GET"),
            ("/api/skills", "PATCH"),
            ("/api/plugins?cwd=%2Frepo", "GET"),
            ("/api/plugins", "POST"),
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
            ("/api/skills", "POST"),
            ("/api/plugins?cwd=%2Frepo&extra=1", "GET"),
            ("/api/project-trust", "GET"),
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
    fn terminal_stream_route_is_a_single_segment_under_terminal_events() {
        let base = test_base();
        assert!(validated_api_endpoint(
            &base,
            "/api/pihub/terminal/term-1/events",
            ApiAccess::TerminalStream,
        )
        .is_ok());

        for path in [
            "/api/pihub/terminal/events",
            "/api/pihub/terminal/term-1/events/extra",
            "/api/pihub/terminal/term-1/events?follow=1",
            "/api/pihub/terminal/..%2Fevents/events",
        ] {
            assert!(
                validated_api_endpoint(&base, path, ApiAccess::TerminalStream).is_err(),
                "accepted {path}"
            );
        }
        // The events route stays out of the generic proxy allowlist.
        assert!(validated_api_endpoint(
            &base,
            "/api/pihub/terminal/term-1/events",
            ApiAccess::Generic { method: "GET" },
        )
        .is_err());
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
            last_event_id: None,
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
}
