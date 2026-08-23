//! Relay transport: the desktop reaches relay-transported nodes through the
//! NATS Core relay (WSS) instead of a direct Tailscale Serve connection.
//!
//! The device URL stays a virtual HTTPS origin (`<nodeId>.nodes.ffuu.eu.org`)
//! so credentials, stream keys and the API route allowlist work unchanged.
//! HMAC request signing is end-to-end: envelopes carry the exact headers the
//! loopback server verifies — the relay and the node connector only move
//! bytes. Protocol source of truth: server/lib/relay-protocol.ts.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use bytes::Bytes;
use futures_util::StreamExt as _;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use crate::credentials::{load_credential, load_relay_token, store_credential};
use crate::transport::{
    relay_request_parts, relay_signed_headers, relay_unsigned_headers, resolve_device_transport,
    validate_health_body, AuthenticatedRequestSpec, DeviceTransport,
};

pub(crate) const RELAY_URL: &str = "wss://relay.ffuu.eu.org";
const RELAY_PROTOCOL_VERSION: u32 = 1;
/// server/lib/relay-protocol.ts RELAY_XFER_CHUNK.
const XFER_CHUNK: usize = 1024 * 1024;
/// server/lib/relay-protocol.ts RELAY_INLINE_LIMIT.
const INLINE_LIMIT: usize = 768 * 1024;
/// server/lib/relay-protocol.ts RELAY_XFER_IDLE_TIMEOUT_MS.
const XFER_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Per-subject buffers; a slow consumer fails its own stream, never the relay.
const STREAM_CHANNEL_CAPACITY: usize = 64;
/// Frames that arrive before their xferId is registered wait here.
const ORPHAN_BUFFER_CAPACITY: usize = 256;

pub(crate) struct RelayResponse {
    pub(crate) status: u16,
    pub(crate) body: Bytes,
}

enum Routed {
    Channel(mpsc::Sender<Result<Bytes, String>>),
    Orphan(Vec<Bytes>),
}

struct RelayState {
    /// streamId -> channel for `node.<id>.events.<streamId>` frames.
    streams: Mutex<HashMap<String, mpsc::Sender<Result<Bytes, String>>>>,
    /// xferId -> channel or pre-registration buffer.
    xfers: Mutex<HashMap<String, Routed>>,
}

impl RelayState {
    fn route(&self, map: &Mutex<HashMap<String, Routed>>, key: &str, data: Bytes) {
        let mut guard = map.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.get_mut(key) {
            Some(Routed::Channel(sender)) => {
                // try_send: full channel = slow consumer, fail this transfer.
                if sender.try_send(Ok(data)).is_err() {
                    guard.remove(key);
                }
            }
            Some(Routed::Orphan(buffer)) => {
                if buffer.len() < ORPHAN_BUFFER_CAPACITY {
                    buffer.push(data);
                }
            }
            None => {
                if guard.len() < ORPHAN_BUFFER_CAPACITY {
                    guard.insert(key.to_owned(), Routed::Orphan(vec![data]));
                }
            }
        }
    }

    fn route_event(&self, stream_id: &str, data: Bytes) {
        let mut guard = self.streams.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(sender) = guard.get(stream_id) else { return };
        if data.first() == Some(&b'{') {
            // stream-end control frame: graceful close (or an error).
            let error = serde_json::from_slice::<serde_json::Value>(&data)
                .ok()
                .and_then(|value| value.get("error")?.as_str().map(str::to_owned));
            match error {
                Some(message) => {
                    let _ = sender.try_send(Err(message));
                }
                None => {}
            }
            guard.remove(stream_id);
            return;
        }
        // Binary frame: 8-byte header (uint32BE seq + uint32BE len).
        if data.len() < 8 {
            guard.remove(stream_id);
            return;
        }
        let length = u32::from_be_bytes([data[4], data[5], data[6], data[7]]) as usize;
        if length != data.len() - 8 {
            guard.remove(stream_id);
            return;
        }
        if sender.try_send(Ok(data.slice(8..))).is_err() {
            guard.remove(stream_id);
        }
    }

    fn fail_all(&self, reason: &str) {
        for (_, sender) in self
            .streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
        {
            let _ = sender.try_send(Err(reason.to_owned()));
        }
        for (_, routed) in self
            .xfers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
        {
            if let Routed::Channel(sender) = routed {
                let _ = sender.try_send(Err(reason.to_owned()));
            }
        }
    }
}

pub(crate) struct RelayClient {
    control: async_nats::Client,
    bulk: async_nats::Client,
    state: std::sync::Arc<RelayState>,
}

fn last_subject_token(subject: &str) -> &str {
    subject.rsplit('.').next().unwrap_or(subject)
}

fn request_subject(node_id: &str) -> String {
    format!("node.{node_id}.request")
}

/// Binary frame encoder (8-byte big-endian header + payload), kept in
/// lockstep with encodeFrame in server/lib/relay-protocol.ts.
fn encode_frame(sequence: u32, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(8 + payload.len());
    frame.extend_from_slice(&sequence.to_be_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

async fn connect_client(token: &str, name: &str, state: std::sync::Arc<RelayState>) -> Result<async_nats::Client, String> {
    let options = async_nats::ConnectOptions::with_user_and_password("desktop".into(), token.to_owned())
        .name(name)
        .event_callback(move |event| {
            let state = state.clone();
            async move {
                if matches!(event, async_nats::Event::Disconnected) {
                    state.fail_all("relay 连接已断开");
                }
            }
        });
    options
        .connect(RELAY_URL)
        .await
        .map_err(|error| format!("无法连接 relay：{error}"))
}

impl RelayClient {
    async fn connect() -> Result<std::sync::Arc<RelayClient>, String> {
        let token = load_relay_token()?
            .ok_or_else(|| "未配置 Relay token（设备中心 → 中继设置）".to_owned())?;
        let state = std::sync::Arc::new(RelayState {
            streams: Mutex::new(HashMap::new()),
            xfers: Mutex::new(HashMap::new()),
        });
        let control = connect_client(&token, "pihub-desktop-control", state.clone()).await?;
        let bulk = connect_client(&token, "pihub-desktop-bulk", state.clone()).await?;

        // Bulk carries the high-volume inbound subjects; both subscriptions use
        // wildcards so frames that race their registration are not lost.
        let events_state = state.clone();
        let mut events = bulk
            .subscribe("node.*.events.>".to_owned())
            .await
            .map_err(|error| format!("无法订阅 relay 事件通道：{error}"))?;
        tauri::async_runtime::spawn(async move {
            while let Some(message) = events.next().await {
                events_state.route_event(last_subject_token(&message.subject), Bytes::from(message.payload.to_vec()));
            }
        });
        let xfer_state = state.clone();
        let mut xfers = bulk
            .subscribe("node.*.xfer.>".to_owned())
            .await
            .map_err(|error| format!("无法订阅 relay 传输通道：{error}"))?;
        tauri::async_runtime::spawn(async move {
            while let Some(message) = xfers.next().await {
                xfer_state.route(&xfer_state.xfers, last_subject_token(&message.subject), Bytes::from(message.payload.to_vec()));
            }
        });
        Ok(std::sync::Arc::new(RelayClient { control, bulk, state }))
    }
}

fn relay_connection() -> &'static Mutex<Option<std::sync::Arc<RelayClient>>> {
    static CONNECTION: OnceLock<Mutex<Option<std::sync::Arc<RelayClient>>>> = OnceLock::new();
    CONNECTION.get_or_init(|| Mutex::new(None))
}

async fn relay_client() -> Result<std::sync::Arc<RelayClient>, String> {
    let existing = relay_connection().lock().unwrap_or_else(|p| p.into_inner()).clone();
    if let Some(client) = existing {
        return Ok(client);
    }
    let client = RelayClient::connect().await?;
    *relay_connection().lock().unwrap_or_else(|p| p.into_inner()) = Some(client.clone());
    Ok(client)
}

/// Forget the pooled relay connection (token change, fatal errors).
pub(crate) fn invalidate_relay_client() {
    if let Some(client) = relay_connection().lock().unwrap_or_else(|p| p.into_inner()).take() {
        client.state.fail_all("relay 连接已重置");
    }
}

fn relay_node_id(base: &url::Url) -> Result<String, String> {
    match resolve_device_transport(base) {
        DeviceTransport::Relay { node_id } => Ok(node_id),
        DeviceTransport::Tailnet => Err("内部错误：非 relay 设备走了 relay 通道".into()),
    }
}

fn new_relay_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // getrandom only fails on unsupported platforms; the app never runs there.
        return format!("fallback-{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    }
    URL_SAFE_NO_PAD.encode(bytes)
}

fn encode_request_envelope(
    id: &str,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: Option<&Bytes>,
) -> Vec<u8> {
    let mut envelope = serde_json::Map::new();
    envelope.insert("v".into(), RELAY_PROTOCOL_VERSION.into());
    envelope.insert("kind".into(), "req".into());
    envelope.insert("id".into(), id.into());
    envelope.insert("method".into(), method.into());
    envelope.insert("path".into(), path.into());
    let header_map: serde_json::Map<String, serde_json::Value> = headers
        .iter()
        .map(|(name, value)| (name.clone(), value.clone().into()))
        .collect();
    envelope.insert("headers".into(), header_map.into());
    if let Some(body) = body {
        envelope.insert("body".into(), BASE64.encode(body).into());
    }
    serde_json::to_vec(&serde_json::Value::Object(envelope)).expect("relay envelope is serializable")
}

fn parse_response_envelope(data: &[u8], expected_id: &str) -> Result<(u16, Bytes, Option<String>), String> {
    let value: serde_json::Value = serde_json::from_slice(data)
        .map_err(|_| "relay 响应不是有效 JSON".to_owned())?;
    if value.get("v").and_then(serde_json::Value::as_u64) != Some(u64::from(RELAY_PROTOCOL_VERSION))
        || value.get("kind").and_then(serde_json::Value::as_str) != Some("res")
    {
        return Err("relay 响应信封无效".into());
    }
    if value.get("id").and_then(serde_json::Value::as_str) != Some(expected_id) {
        return Err("relay 响应与请求不匹配".into());
    }
    let status = value
        .get("status")
        .and_then(serde_json::Value::as_u64)
        .and_then(|code| u16::try_from(code).ok())
        .filter(|code| (100..600).contains(code))
        .ok_or_else(|| "relay 响应状态码无效".to_owned())?;
    if let Some(error) = value.get("error").and_then(serde_json::Value::as_str) {
        return Err(format!("节点处理失败（HTTP {status}）：{error}"));
    }
    if let Some(xfer) = value.get("xfer").and_then(serde_json::Value::as_str) {
        return Ok((status, Bytes::new(), Some(xfer.to_owned())));
    }
    let body = match value.get("body").and_then(serde_json::Value::as_str) {
        Some(encoded) => Bytes::from(
            BASE64.decode(encoded).map_err(|_| "relay 响应 body 不是有效 base64".to_owned())?,
        ),
        None => Bytes::new(),
    };
    Ok((status, body, None))
}

async fn relay_round_trip(
    client: &RelayClient,
    node_id: &str,
    envelope: Vec<u8>,
    timeout: Duration,
    channel: Channel,
) -> Result<Bytes, String> {
    let subject = request_subject(node_id);
    let connection = match channel {
        Channel::Control => &client.control,
        Channel::Bulk => &client.bulk,
    };
    let request = connection.request(subject, Bytes::from(envelope));
    let message = match tokio::time::timeout(timeout, request).await {
        Ok(Ok(message)) => message,
        Ok(Err(error)) => {
            return Err(if error.kind() == async_nats::RequestErrorKind::NoResponders {
                "节点不在线或 connector 未运行".to_owned()
            } else {
                format!("relay 请求失败：{error}")
            });
        }
        Err(_) => return Err("relay 请求超时".into()),
    };
    Ok(Bytes::from(message.payload.to_vec()))
}

/// Reassemble a chunked transfer from `node.<id>.xfer.<xferId>`.
async fn receive_xfer(
    client: &RelayClient,
    xfer_id: &str,
    max_bytes: usize,
) -> Result<Bytes, String> {
    let (sender, mut receiver) = mpsc::channel(STREAM_CHANNEL_CAPACITY);
    let mut orphans = Vec::new();
    {
        let mut guard = client.state.xfers.lock().unwrap_or_else(|p| p.into_inner());
        match guard.insert(xfer_id.to_owned(), Routed::Channel(sender)) {
            Some(Routed::Orphan(buffered)) => orphans = buffered,
            _ => {}
        }
    }
    let mut expected: Option<(String, Option<u64>)> = None; // (sha256, size)
    let mut hasher = Sha256::new();
    let mut received: usize = 0;
    let mut body = Vec::new();

    let pump = |data: Bytes,
                    expected: &mut Option<(String, Option<u64>)>,
                    hasher: &mut Sha256,
                    received: &mut usize,
                    body: &mut Vec<u8>|
     -> Result<bool, String> {
        if data.first() == Some(&b'{') {
            let value: serde_json::Value = serde_json::from_slice(&data)
                .map_err(|_| "xfer 控制帧不是有效 JSON".to_owned())?;
            match value.get("kind").and_then(serde_json::Value::as_str) {
                Some("xfer-open") => {
                    let sha256 = value
                        .get("sha256")
                        .and_then(serde_json::Value::as_str)
                        .filter(|digest| digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()))
                        .ok_or_else(|| "xfer-open 摘要无效".to_owned())?
                        .to_owned();
                    let size = value.get("size").and_then(serde_json::Value::as_u64);
                    *expected = Some((sha256, size));
                    Ok(false)
                }
                Some("xfer-close") => {
                    if value.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
                        let error = value
                            .get("error")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("传输被节点中止");
                        return Err(format!("xfer 失败：{error}"));
                    }
                    Ok(true)
                }
                _ => Err("xfer 控制帧类型未知".into()),
            }
        } else {
            if data.len() < 8 {
                return Err("xfer 数据帧过短".into());
            }
            let length = u32::from_be_bytes([data[4], data[5], data[6], data[7]]) as usize;
            if length != data.len() - 8 || length > XFER_CHUNK {
                return Err("xfer 数据帧长度无效".into());
            }
            let payload = data.slice(8..);
            *received += payload.len();
            if *received > max_bytes {
                return Err("xfer 超出大小上限".into());
            }
            hasher.update(&payload);
            body.extend_from_slice(&payload);
            Ok(false)
        }
    };

    for orphan in orphans {
        if pump(orphan, &mut expected, &mut hasher, &mut received, &mut body)? {
            return finish_xfer(client, xfer_id, expected, hasher, body);
        }
    }
    loop {
        let next = tokio::time::timeout(XFER_IDLE_TIMEOUT, receiver.recv()).await;
        match next {
            Ok(Some(Ok(data))) => {
                if pump(data, &mut expected, &mut hasher, &mut received, &mut body)? {
                    return finish_xfer(client, xfer_id, expected, hasher, body);
                }
            }
            Ok(Some(Err(error))) => {
                unregister_xfer(client, xfer_id);
                return Err(error);
            }
            Ok(None) => {
                unregister_xfer(client, xfer_id);
                return Err("xfer 通道意外关闭".into());
            }
            Err(_) => {
                unregister_xfer(client, xfer_id);
                return Err("xfer 传输超时".into());
            }
        }
    }
}

fn unregister_xfer(client: &RelayClient, xfer_id: &str) {
    client
        .state
        .xfers
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(xfer_id);
}

fn finish_xfer(
    client: &RelayClient,
    xfer_id: &str,
    expected: Option<(String, Option<u64>)>,
    hasher: Sha256,
    body: Vec<u8>,
) -> Result<Bytes, String> {
    unregister_xfer(client, xfer_id);
    let Some((sha256, size)) = expected else {
        return Err("xfer 缺少 open 帧".into());
    };
    if let Some(size) = size {
        if size != body.len() as u64 {
            return Err("xfer 大小与声明不符".into());
        }
    }
    let digest = hex::encode(hasher.finalize());
    if digest != sha256 {
        return Err("xfer 摘要校验失败".into());
    }
    Ok(Bytes::from(body))
}

/// Unsigned relay request (pairing claim, health probes).
pub(crate) async fn send_relay_unsigned(
    base: &url::Url,
    spec: &AuthenticatedRequestSpec,
    max_bytes: usize,
) -> Result<RelayResponse, String> {
    let node_id = relay_node_id(base)?;
    let client = relay_client().await?;
    let headers = relay_unsigned_headers(spec);
    send_relay_envelope(&client, &node_id, spec, headers, max_bytes).await
}

/// Relay equivalent of transport::fetch_authentication_metadata.
pub(crate) async fn fetch_relay_authentication_metadata(
    base: &url::Url,
) -> Result<(crate::transport::AuthenticationMetadata, i64), String> {
    let endpoint = base
        .join("/api/health")
        .map_err(|_| "设备健康检查地址无效".to_owned())?;
    let spec = AuthenticatedRequestSpec::empty(reqwest::Method::GET, endpoint, Duration::from_secs(12))
        .accepting("application/json");
    let local_sent = crate::transport::local_unix_seconds()?;
    let response = send_relay_unsigned(base, &spec, 8 * 1024).await?;
    let local_received = crate::transport::local_unix_seconds()?;
    if !(200..300).contains(&response.status) {
        return Err(format!("设备健康检查返回 HTTP {}", response.status));
    }
    validate_health_body(&response.body, local_sent, local_received)
}

async fn send_relay_signed_attempt(
    client: &RelayClient,
    node_id: &str,
    spec: &AuthenticatedRequestSpec,
    credential: &crate::credentials::StoredCredential,
    max_bytes: usize,
) -> Result<RelayResponse, String> {
    let headers = relay_signed_headers(spec, credential)?;
    send_relay_envelope(client, node_id, spec, headers, max_bytes).await
}

/// Signed relay request with the same 401-refresh-and-retry semantics as
/// send_authenticated on the tailnet path.
pub(crate) async fn send_relay_authenticated(
    base: &url::Url,
    spec: &AuthenticatedRequestSpec,
    max_bytes: usize,
) -> Result<RelayResponse, String> {
    let node_id = relay_node_id(base)?;
    let mut credential = load_credential(base)
        .await?
        .ok_or_else(|| "PIHUB_AUTH_REQUIRED: 此设备尚未与 PiHub 配对".to_owned())?;
    let client = relay_client().await?;
    let response = send_relay_signed_attempt(&client, &node_id, spec, &credential, max_bytes).await?;
    if response.status == 403 {
        return Err("PIHUB_AUTH_FORBIDDEN: 当前设备凭据没有执行此操作的权限".into());
    }
    if response.status != 401 {
        return Ok(response);
    }

    // 401: refresh epoch/clock offset over the relay and retry once.
    let metadata_spec = {
        let endpoint = base
            .join("/api/health")
            .map_err(|_| "设备健康检查地址无效".to_owned())?;
        AuthenticatedRequestSpec::empty(reqwest::Method::GET, endpoint, Duration::from_secs(12))
            .accepting("application/json")
    };
    let local_sent = crate::transport::local_unix_seconds()?;
    let health = send_relay_envelope(&client, &node_id, &metadata_spec, relay_unsigned_headers(&metadata_spec), 8 * 1024).await?;
    let local_received = crate::transport::local_unix_seconds()?;
    if !(200..300).contains(&health.status) {
        return Err(format!("设备健康检查返回 HTTP {}", health.status));
    }
    let (metadata, offset) = validate_health_body(&health.body, local_sent, local_received)?;
    credential.epoch = metadata.epoch;
    credential.clock_offset_seconds = offset;
    credential.timestamp_window_seconds = metadata.timestamp_window_seconds;
    store_credential(credential.clone()).await?;

    let response = send_relay_signed_attempt(&client, &node_id, spec, &credential, max_bytes).await?;
    match response.status {
        401 => Err("PIHUB_AUTH_REQUIRED: 设备凭据已失效或被撤销，请重新配对".into()),
        403 => Err("PIHUB_AUTH_FORBIDDEN: 当前设备凭据没有执行此操作的权限".into()),
        _ => Ok(response),
    }
}

#[derive(Clone, Copy)]
enum Channel {
    Control,
    Bulk,
}

/// Publish a request body as a chunked outbound transfer on the bulk
/// connection, then send the envelope referencing it on the same connection so
/// per-connection ordering guarantees the connector sees open+frames before
/// the request. Mirrors the connector's inbound xfer reader.
async fn send_body_xfer(
    client: &RelayClient,
    node_id: &str,
    xfer_id: &str,
    body: &[u8],
) -> Result<(), String> {
    let subject = format!("node.{node_id}.xfer.{xfer_id}");
    let open = serde_json::to_vec(&serde_json::json!({
        "v": RELAY_PROTOCOL_VERSION,
        "kind": "xfer-open",
        "xferId": xfer_id,
        "size": body.len(),
        "sha256": hex::encode(Sha256::digest(body)),
    }))
    .expect("xfer-open is serializable");
    client.bulk.publish(subject.clone(), Bytes::from(open)).await
        .map_err(|error| format!("无法发送传输头：{error}"))?;
    for (sequence, chunk) in body.chunks(XFER_CHUNK).enumerate() {
        client.bulk.publish(subject.clone(), Bytes::from(encode_frame(sequence as u32, chunk))).await
            .map_err(|error| format!("无法发送传输分块：{error}"))?;
    }
    let close = serde_json::to_vec(&serde_json::json!({
        "v": RELAY_PROTOCOL_VERSION, "kind": "xfer-close", "xferId": xfer_id, "ok": true,
    }))
    .expect("xfer-close is serializable");
    client.bulk.publish(subject, Bytes::from(close)).await
        .map_err(|error| format!("无法发送传输尾帧：{error}"))?;
    Ok(())
}

async fn send_relay_envelope(
    client: &RelayClient,
    node_id: &str,
    spec: &AuthenticatedRequestSpec,
    headers: Vec<(String, String)>,
    max_bytes: usize,
) -> Result<RelayResponse, String> {
    let (method, path, body) = relay_request_parts(spec)?;
    let id = new_relay_id();
    // Bodies above the inline limit travel as a chunked xfer on the bulk
    // connection; the request envelope references the transfer instead.
    let (envelope, channel) = match body.as_ref().filter(|body| body.len() > INLINE_LIMIT) {
        Some(large) => {
            let xfer_id = new_relay_id();
            send_body_xfer(client, node_id, &xfer_id, large).await?;
            let mut envelope = serde_json::Map::new();
            envelope.insert("v".into(), RELAY_PROTOCOL_VERSION.into());
            envelope.insert("kind".into(), "req".into());
            envelope.insert("id".into(), id.clone().into());
            envelope.insert("method".into(), method.into());
            envelope.insert("path".into(), path.into());
            let header_map: serde_json::Map<String, serde_json::Value> = headers
                .iter()
                .map(|(name, value)| (name.clone(), value.clone().into()))
                .collect();
            envelope.insert("headers".into(), header_map.into());
            envelope.insert("xfer".into(), xfer_id.into());
            (
                serde_json::to_vec(&serde_json::Value::Object(envelope))
                    .expect("relay envelope is serializable"),
                Channel::Bulk,
            )
        }
        None => (encode_request_envelope(&id, &method, &path, &headers, body.as_ref()), Channel::Control),
    };
    let timeout = spec.timeout_budget().unwrap_or(DEFAULT_REQUEST_TIMEOUT);
    let reply = relay_round_trip(client, node_id, envelope, timeout, channel).await?;
    let (status, inline_body, xfer) = parse_response_envelope(&reply, &id)?;
    let body = match xfer {
        Some(xfer_id) => receive_xfer(client, &xfer_id, max_bytes).await?,
        None => {
            if inline_body.len() > max_bytes {
                return Err("relay 响应超出大小上限".into());
            }
            inline_body
        }
    };
    Ok(RelayResponse { status, body })
}

// ── streams ─────────────────────────────────────────────────────────────────

pub(crate) struct RelayStream {
    pub(crate) stream_id: String,
    pub(crate) receiver: mpsc::Receiver<Result<Bytes, String>>,
    node_id: String,
    client: std::sync::Arc<RelayClient>,
}

/// Open a relayed SSE stream. Returns once the open message is published; the
/// node's stream-end (or a relay disconnect) closes the receiver, which the
/// caller surfaces exactly like a dropped SSE connection.
pub(crate) async fn open_relay_stream(
    base: &url::Url,
    spec: &AuthenticatedRequestSpec,
) -> Result<RelayStream, String> {
    let node_id = relay_node_id(base)?;
    let credential = load_credential(base)
        .await?
        .ok_or_else(|| "PIHUB_AUTH_REQUIRED: 此设备尚未与 PiHub 配对".to_owned())?;
    let client = relay_client().await?;
    let (_, path, _) = relay_request_parts(spec)?;
    let headers: HashMap<String, String> = relay_signed_headers(spec, &credential)?.into_iter().collect();
    let stream_id = new_relay_id();
    let (sender, receiver) = mpsc::channel(STREAM_CHANNEL_CAPACITY);
    client
        .state
        .streams
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(stream_id.clone(), sender);
    let envelope = serde_json::to_vec(&serde_json::json!({
        "v": RELAY_PROTOCOL_VERSION,
        "kind": "stream-open",
        "streamId": stream_id,
        "path": path,
        "headers": headers,
    }))
    .expect("stream-open is serializable");
    client
        .bulk
        .publish(format!("node.{node_id}.stream.open"), Bytes::from(envelope))
        .await
        .map_err(|error| format!("无法打开发流请求：{error}"))?;
    Ok(RelayStream {
        stream_id,
        receiver,
        node_id,
        client,
    })
}

impl Drop for RelayStream {
    fn drop(&mut self) {
        self.client
            .state
            .streams
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.stream_id);
        // Best-effort close notification so the connector aborts the local
        // upstream stream instead of leaking it until the node stops.
        let client = self.client.clone();
        let subject = format!("node.{}.stream.close", self.node_id);
        let envelope = serde_json::to_vec(&serde_json::json!({
            "v": RELAY_PROTOCOL_VERSION,
            "kind": "stream-close",
            "streamId": self.stream_id,
        }))
        .expect("stream-close is serializable");
        tauri::async_runtime::spawn(async move {
            let _ = client.bulk.publish(subject, Bytes::from(envelope)).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Byte-level fixtures mirrored from server/lib/relay-protocol.ts
    // RELAY_PROTOCOL_TEST_VECTORS — both sides must stay in lockstep.

    #[test]
    fn frame_encoding_matches_the_shared_vector() {
        let frame = encode_frame(7, b"pihub");
        assert_eq!(
            hex::encode(&frame),
            "00000007000000057069687562"
        );
    }

    #[test]
    fn subjects_match_the_shared_vector() {
        assert_eq!(request_subject("dgn-01"), "node.dgn-01.request");
        assert_eq!(format!("node.{}.stream.open", "dgn-01"), "node.dgn-01.stream.open");
        assert_eq!(format!("node.{}.stream.close", "dgn-01"), "node.dgn-01.stream.close");
        assert_eq!(format!("node.{}.events.{}", "dgn-01", "stream-A1"), "node.dgn-01.events.stream-A1");
        assert_eq!(format!("node.{}.xfer.{}", "dgn-01", "xfer-B2x4"), "node.dgn-01.xfer.xfer-B2x4");
    }

    #[test]
    fn request_envelope_matches_the_shared_vector_semantics() {
        let headers = vec![("authorization".to_owned(), "PiHub-HMAC-SHA256 dev_x".to_owned())];
        let encoded = encode_request_envelope("AbCdEfGh1234", "GET", "/api/sessions?limit=40", &headers, None);
        let expected: serde_json::Value = serde_json::from_str(
            "{\"v\":1,\"kind\":\"req\",\"id\":\"AbCdEfGh1234\",\"method\":\"GET\",\"path\":\"/api/sessions?limit=40\",\"headers\":{\"authorization\":\"PiHub-HMAC-SHA256 dev_x\"}}",
        )
        .unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&encoded).unwrap(), expected);
    }

    #[test]
    fn response_envelope_parsing_covers_inline_xfer_and_error() {
        let inline = serde_json::to_vec(&serde_json::json!({
            "v": 1, "kind": "res", "id": "AbCdEfGh1234", "status": 200,
            "headers": {}, "body": BASE64.encode(b"hello"),
        })).unwrap();
        let (status, body, xfer) = parse_response_envelope(&inline, "AbCdEfGh1234").unwrap();
        assert_eq!(status, 200);
        assert_eq!(&body[..], b"hello");
        assert!(xfer.is_none());

        let chunked = serde_json::to_vec(&serde_json::json!({
            "v": 1, "kind": "res", "id": "AbCdEfGh1234", "status": 200, "headers": {}, "xfer": "xfer-B2x4",
        })).unwrap();
        let (_, body, xfer) = parse_response_envelope(&chunked, "AbCdEfGh1234").unwrap();
        assert!(body.is_empty());
        assert_eq!(xfer.as_deref(), Some("xfer-B2x4"));

        let failed = serde_json::to_vec(&serde_json::json!({
            "v": 1, "kind": "res", "id": "AbCdEfGh1234", "status": 502, "headers": {}, "error": "local replay failed",
        })).unwrap();
        assert!(parse_response_envelope(&failed, "AbCdEfGh1234").unwrap_err().contains("502"));

        let mismatched = serde_json::to_vec(&serde_json::json!({
            "v": 1, "kind": "res", "id": "other-id-999", "status": 200, "headers": {},
        })).unwrap();
        assert!(parse_response_envelope(&mismatched, "AbCdEfGh1234").is_err());

        let wrong_version = serde_json::to_vec(&serde_json::json!({
            "v": 2, "kind": "res", "id": "AbCdEfGh1234", "status": 200, "headers": {},
        })).unwrap();
        assert!(parse_response_envelope(&wrong_version, "AbCdEfGh1234").is_err());
    }
}
