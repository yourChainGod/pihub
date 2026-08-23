use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::transport::{
    resolve_device_transport, send_authenticated, validate_tailnet_url, validated_api_endpoint,
    ApiAccess, AuthenticatedRequestSpec, DeviceTransport,
};

/// Chunk source shared by the two stream transports. A relay stream surfaces
/// node stream-end exactly like a dropped SSE connection (Ok(None)); the
/// decoder/reconnect semantics above stay identical.
pub(crate) enum StreamChunks {
    Http(reqwest::Response),
    Relay(crate::relay::RelayStream),
}

impl StreamChunks {
    async fn next_chunk(&mut self) -> Option<Result<bytes::Bytes, String>> {
        match self {
            Self::Http(response) => match response.chunk().await {
                Ok(chunk) => chunk.map(Ok),
                Err(error) => Some(Err(error.to_string())),
            },
            Self::Relay(stream) => stream.receiver.recv().await,
        }
    }
}

/// Open the byte source for an event stream on whichever transport the device
/// URL selects. Ok(None) means the caller cancelled while connecting.
async fn open_stream_chunks(
    base: &url::Url,
    spec: &AuthenticatedRequestSpec,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<Option<StreamChunks>, String> {
    match resolve_device_transport(base) {
        DeviceTransport::Tailnet => {
            let response = tokio::select! {
                _ = cancel_rx => return Ok(None),
                response = send_authenticated(base, spec) => response?,
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
            Ok(Some(StreamChunks::Http(response)))
        }
        DeviceTransport::Relay { .. } => {
            let stream = tokio::select! {
                _ = cancel_rx => return Ok(None),
                stream = crate::relay::open_relay_stream(base, spec) => stream?,
            };
            Ok(Some(StreamChunks::Relay(stream)))
        }
    }
}

pub(crate) const MAX_SSE_BUFFER_BYTES: usize = 1024 * 1024;

/// A decoded SSE event. The payload stays as validated raw JSON so forwarding to
/// the WebView is a byte copy instead of a `Value` tree walk; the control fields
/// the stream handlers dispatch on are lifted out during that same validation.
#[derive(Clone, Debug)]
pub(crate) struct StreamEvent {
    payload: Box<RawValue>,
    event_type: Option<String>,
    error_message: Option<String>,
}

/// Only the two control fields are materialised; every other member of the frame
/// is skipped by `IgnoredAny` without building a `Value`. Non-object frames and
/// non-string field types stay tolerated, matching the previous `Value::as_str`.
#[derive(Default, Deserialize)]
struct StreamEventFields {
    #[serde(rename = "type", default)]
    event_type: Option<Value>,
    #[serde(rename = "errorMessage", default)]
    error_message: Option<Value>,
}

impl StreamEvent {
    pub(crate) fn event_type(&self) -> Option<&str> {
        self.event_type.as_deref()
    }

    pub(crate) fn error_message(&self) -> Option<&str> {
        self.error_message.as_deref()
    }

    fn parse(json: String) -> Result<Self, String> {
        // `from_string` both validates and takes ownership of the buffer, so this
        // is the only parse pass over the frame.
        let payload =
            RawValue::from_string(json).map_err(|_| "实时事件不是有效的 JSON".to_owned())?;
        let fields =
            serde_json::from_str::<StreamEventFields>(payload.get()).unwrap_or_default();
        let as_owned_str =
            |value: Option<Value>| value.as_ref().and_then(Value::as_str).map(str::to_owned);
        Ok(Self {
            event_type: as_owned_str(fields.event_type),
            error_message: as_owned_str(fields.error_message),
            payload,
        })
    }

    /// Build a synthetic frame (for local errors that need forwarding as events).
    fn stream_error(message: &str) -> Self {
        let json = serde_json::json!({ "type": "stream_error", "errorMessage": message });
        let json_str = json.to_string();
        Self {
            event_type: Some("stream_error".to_owned()),
            error_message: Some(message.to_owned()),
            payload: RawValue::from_string(json_str).expect("synthetic JSON is always valid"),
        }
    }
}

#[cfg(test)]
impl StreamEvent {
    fn as_value(&self) -> Value {
        serde_json::from_str(self.payload.get()).expect("payload was validated at decode time")
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct StreamKey {
    device_id: String,
    origin: String,
    session_id: String,
}

pub(crate) struct ActiveStream {
    generation: u64,
    cancel: tokio::sync::oneshot::Sender<()>,
}

pub(crate) fn stream_registry() -> &'static Mutex<HashMap<StreamKey, ActiveStream>> {
    static STREAMS: OnceLock<Mutex<HashMap<StreamKey, ActiveStream>>> = OnceLock::new();
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn stream_key(
    device_id: String,
    base: &url::Url,
    session_id: String,
) -> Result<StreamKey, String> {
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

pub(crate) fn install_stream(
    key: StreamKey,
) -> Result<(u64, tokio::sync::oneshot::Receiver<()>), String> {
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

pub(crate) fn stream_is_current(key: &StreamKey, generation: u64) -> bool {
    stream_registry()
        .lock()
        .ok()
        .and_then(|streams| streams.get(key).map(|stream| stream.generation))
        == Some(generation)
}

/// Last replayable SSE event id seen per stream key; lets a reconnecting agent
/// stream resume the server's replay ring instead of taking a fresh snapshot.
fn last_event_ids() -> &'static Mutex<HashMap<StreamKey, u64>> {
    static IDS: OnceLock<Mutex<HashMap<StreamKey, u64>>> = OnceLock::new();
    IDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn record_stream_event_id(key: &StreamKey, id: u64) {
    if let Ok(mut ids) = last_event_ids().lock() {
        if ids.len() >= 512 {
            // Unbounded growth is not worth precise resume cursors; dropping
            // all entries merely falls reconnects back to snapshot mode.
            ids.clear();
        }
        let entry = ids.entry(key.clone()).or_insert(0);
        *entry = (*entry).max(id);
    }
}

fn resume_cursor(key: &StreamKey) -> Option<u64> {
    last_event_ids().lock().ok()?.get(key).copied()
}

fn clear_resume_cursor(key: &StreamKey) {
    if let Ok(mut ids) = last_event_ids().lock() {
        ids.remove(key);
    }
}

pub(crate) fn cancel_stream(key: &StreamKey, generation: Option<u64>) -> Result<(), String> {
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
pub(crate) struct SseDecoder {
    line: Vec<u8>,
    data_lines: Vec<Vec<u8>>,
    data_bytes: usize,
    pending_cr: bool,
    saw_first_line: bool,
    event_id: Option<u64>,
    last_id: Option<u64>,
}

impl SseDecoder {
    /// The `id:` of the most recently dispatched event; replayed frames and
    /// live publishes carry one, control frames (connected, replay_reset) do not.
    pub(crate) fn last_event_id(&self) -> Option<u64> {
        self.last_id
    }

    fn buffered_bytes(&self) -> usize {
        self.line.len() + self.data_bytes + usize::from(self.pending_cr)
    }

    fn push(&mut self, chunk: &[u8]) -> Result<Vec<StreamEvent>, String> {
        let mut events = Vec::new();
        let mut pos = 0;

        // A CR that ended the previous chunk already flushed its line; the only
        // thing left to do is swallow the LF half of a CRLF split across chunks.
        if self.pending_cr {
            self.pending_cr = false;
            if chunk.first() == Some(&b'\n') {
                pos = 1;
            }
        }

        // Batch-locate all line breaks in the chunk, then process the slices between them.
        while pos < chunk.len() {
            let search = &chunk[pos..];
            match memchr::memchr2(b'\r', b'\n', search) {
                None => {
                    // No more line breaks in this chunk; accumulate the rest.
                    self.line.extend_from_slice(search);
                    if self.buffered_bytes() > MAX_SSE_BUFFER_BYTES {
                        return Err("实时事件缓冲区超过 1MB 上限".into());
                    }
                    break;
                }
                Some(offset) => {
                    // Accumulate bytes up to the line break.
                    self.line.extend_from_slice(&search[..offset]);
                    if self.buffered_bytes() > MAX_SSE_BUFFER_BYTES {
                        return Err("实时事件缓冲区超过 1MB 上限".into());
                    }
                    let delim = search[offset];
                    pos += offset + 1;

                    if delim == b'\r' {
                        // CR may be followed by LF, but it's a line break either way.
                        if let Some(event) = self.finish_line()? {
                            events.push(event);
                        }
                        // If the next byte is LF, consume it; otherwise leave pending_cr
                        // in case the LF arrives in the next chunk.
                        if pos < chunk.len() && chunk[pos] == b'\n' {
                            pos += 1;
                        } else if pos == chunk.len() {
                            self.pending_cr = true;
                        }
                    } else {
                        // LF always finishes a line.
                        if let Some(event) = self.finish_line()? {
                            events.push(event);
                        }
                    }
                }
            }
        }
        Ok(events)
    }

    fn finish(&mut self) -> Result<Vec<StreamEvent>, String> {
        let mut events = Vec::new();
        // A trailing CR already flushed its line during `push`, so only a real
        // unterminated remainder is left to flush here.
        self.pending_cr = false;
        if !self.line.is_empty() {
            if let Some(event) = self.finish_line()? {
                events.push(event);
            }
        }
        if let Some(event) = self.dispatch()? {
            events.push(event);
        }
        Ok(events)
    }

    fn finish_line(&mut self) -> Result<Option<StreamEvent>, String> {
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
        if &line[..colon] == b"id" {
            let mut value: &[u8] = if colon == line.len() {
                &[]
            } else {
                &line[colon + 1..]
            };
            if value.first() == Some(&b' ') {
                value = &value[1..];
            }
            // A non-numeric id resets the resume cursor per the SSE spec.
            self.event_id = match std::str::from_utf8(value) {
                Ok(text) if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) => {
                    text.parse::<u64>().ok()
                }
                _ => None,
            };
            return Ok(None);
        }
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

    fn dispatch(&mut self) -> Result<Option<StreamEvent>, String> {
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
        if let Some(id) = self.event_id.take() {
            self.last_id = Some(id);
        }
        // Reusing the assembled buffer keeps the payload out of a second copy.
        let text = String::from_utf8(data).map_err(|_| "实时事件不是有效的 UTF-8".to_owned())?;
        StreamEvent::parse(text).map(Some)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentStreamPayload {
    device_id: String,
    device_origin: String,
    session_id: String,
    generation: u64,
    event: Box<RawValue>,
}

pub(crate) fn emit_agent_stream_event(
    app: &AppHandle,
    key: &StreamKey,
    generation: u64,
    event: StreamEvent,
    ready: &mut Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
) -> Result<bool, String> {
    if !stream_is_current(key, generation) {
        return Ok(false);
    }
    let event_type = event.event_type();
    if event_type == Some("connected") {
        if let Some(sender) = ready.take() {
            let _ = sender.send(Ok(()));
        }
    }
    let startup_error = (event_type == Some("startup_error")).then(|| {
        event
            .error_message()
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
            event: event.payload,
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
pub(crate) async fn start_agent_stream(
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
            .resuming_after(resume_cursor(&key))
            .without_timeout();
    let (generation, mut cancel_rx) = install_stream(key.clone())?;
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let task_key = key.clone();
    let task_base = base.clone();
    tauri::async_runtime::spawn(async move {
        let mut ready_tx = Some(ready_tx);
        let run: Result<(), String> = async {
            let Some(mut source) = open_stream_chunks(&task_base, &spec, &mut cancel_rx).await?
            else {
                return Ok(());
            };
            let mut decoder = SseDecoder::default();
            loop {
                let next = tokio::select! {
                    _ = &mut cancel_rx => return Ok(()),
                    next = source.next_chunk() => next,
                };
                let Some(chunk) = next else {
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
                    if let Some(id) = decoder.last_event_id() {
                        record_stream_event_id(&task_key, id);
                    }
                    return Err("实时连接已关闭".into());
                };
                let chunk = chunk?;
                for event in decoder.push(&chunk)? {
                    if !emit_agent_stream_event(&app, &task_key, generation, event, &mut ready_tx)?
                    {
                        return Ok(());
                    }
                }
                if let Some(id) = decoder.last_event_id() {
                    record_stream_event_id(&task_key, id);
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
                        event: StreamEvent::stream_error(&error).payload,
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
pub(crate) fn stop_agent_stream(
    url: String,
    device_id: String,
    session_id: String,
) -> Result<(), String> {
    let base = validate_tailnet_url(&url)?;
    let key = stream_key(device_id, &base, session_id)?;
    // Deliberate stops (run settled) reset the resume cursor; the next stream
    // starts from a fresh snapshot instead of replaying an already-seen run.
    clear_resume_cursor(&key);
    cancel_stream(&key, None)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalStreamPayload {
    device_id: String,
    device_origin: String,
    terminal_id: String,
    generation: u64,
    event: Box<RawValue>,
}

/// Terminal streams share the global registry with agent streams; the `term:`
/// prefix keeps the two kinds from evicting each other on identical raw ids.
pub(crate) fn terminal_stream_key(
    device_id: String,
    base: &url::Url,
    terminal_id: &str,
) -> Result<StreamKey, String> {
    stream_key(device_id, base, format!("term:{terminal_id}"))
}

fn emit_terminal_stream_event(
    app: &AppHandle,
    key: &StreamKey,
    terminal_id: &str,
    generation: u64,
    event: StreamEvent,
) -> Result<bool, String> {
    if !stream_is_current(key, generation) {
        return Ok(false);
    }
    app.emit(
        "pihub-terminal-event",
        TerminalStreamPayload {
            device_id: key.device_id.clone(),
            device_origin: key.origin.clone(),
            terminal_id: terminal_id.to_owned(),
            generation,
            event: event.payload,
        },
    )
    .map_err(|error| format!("无法投递实时事件：{error}"))?;
    Ok(true)
}

// Unlike the agent stream there is no `connected` event here: the first SSE
// frame is already the output snapshot. The connection counts as ready once
// the response headers confirm a successful event-stream.
#[tauri::command]
pub(crate) async fn start_terminal_stream(
    app: AppHandle,
    url: String,
    device_id: String,
    terminal_id: String,
) -> Result<u64, String> {
    let base = validate_tailnet_url(&url)?;
    let key = terminal_stream_key(device_id, &base, &terminal_id)?;
    let encoded: String = url::form_urlencoded::byte_serialize(terminal_id.as_bytes()).collect();
    let endpoint = validated_api_endpoint(
        &base,
        &format!("/api/pihub/terminal/{encoded}/events"),
        ApiAccess::TerminalStream,
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
        let relay_mode = matches!(resolve_device_transport(&task_base), DeviceTransport::Relay { .. });
        let run: Result<(), String> = async {
            let Some(mut source) = open_stream_chunks(&task_base, &spec, &mut cancel_rx).await?
            else {
                return Ok(());
            };
            if relay_mode {
                // The relay path has no response headers to inspect; the first
                // frame (or a stream-end error) follows on the channel.
                if let Some(sender) = ready_tx.take() {
                    let _ = sender.send(Ok(()));
                }
            }
            let mut decoder = SseDecoder::default();
            loop {
                let next = tokio::select! {
                    _ = &mut cancel_rx => return Ok(()),
                    next = source.next_chunk() => next,
                };
                let Some(chunk) = next else {
                    for event in decoder.finish()? {
                        if !emit_terminal_stream_event(
                            &app,
                            &task_key,
                            &terminal_id,
                            generation,
                            event,
                        )? {
                            return Ok(());
                        }
                    }
                    return Err("实时连接已关闭".into());
                };
                let chunk = chunk?;
                for event in decoder.push(&chunk)? {
                    if !emit_terminal_stream_event(
                        &app,
                        &task_key,
                        &terminal_id,
                        generation,
                        event,
                    )? {
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
                    "pihub-terminal-event",
                    TerminalStreamPayload {
                        device_id: task_key.device_id.clone(),
                        device_origin: task_key.origin.clone(),
                        terminal_id: terminal_id.clone(),
                        generation,
                        event: StreamEvent::stream_error(&error).payload,
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
            Err("实时终端连接提前关闭".into())
        }
        Err(_) => {
            let _ = cancel_stream(&key, Some(generation));
            Err("等待实时终端连接超时，已取消后台连接".into())
        }
    }
}

#[tauri::command]
pub(crate) fn stop_terminal_stream(
    url: String,
    device_id: String,
    terminal_id: String,
) -> Result<(), String> {
    let base = validate_tailnet_url(&url)?;
    let key = terminal_stream_key(device_id, &base, &terminal_id)?;
    cancel_stream(&key, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_base() -> url::Url {
        crate::transport::validate_tailnet_url("https://device.example.ts.net:30141").unwrap()
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
        assert_eq!(events[0].as_value()["text"], "你好🌟");
        assert_eq!(events[1].as_value()["type"], "done");
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

    #[test]
    fn sse_decoder_tracks_event_ids_for_replay_resume() {
        let mut decoder = SseDecoder::default();
        let events = decoder
            .push(b"id: 41\ndata: {\"type\":\"message_end\"}\n\n: keep-alive\n\ndata: {\"type\":\"connected\"}\n\nid: 42\ndata: {\"type\":\"message_start\"}\n\n")
            .unwrap();
        assert_eq!(events.len(), 3);
        // Control frames without an id keep the cursor at the last replayable id.
        assert_eq!(decoder.last_event_id(), Some(42));

        let mut invalid = SseDecoder::default();
        invalid
            .push(b"id: abc\ndata: {\"type\":\"message_end\"}\n\n")
            .unwrap();
        assert_eq!(invalid.last_event_id(), None);
    }

    #[test]
    fn resume_cursor_roundtrip_and_deliberate_clear() {
        let base = test_base();
        let suffix = std::process::id().to_string();
        let key = stream_key(format!("device-resume-{suffix}"), &base, "session-1".into()).unwrap();
        assert_eq!(resume_cursor(&key), None);
        record_stream_event_id(&key, 7);
        record_stream_event_id(&key, 3); // ids only move forward
        assert_eq!(resume_cursor(&key), Some(7));
        clear_resume_cursor(&key);
        assert_eq!(resume_cursor(&key), None);
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

    #[tokio::test]
    async fn terminal_stream_key_does_not_evict_agent_stream() {
        let base = test_base();
        let suffix = std::process::id().to_string();
        let agent = stream_key(format!("device-a-{suffix}"), &base, "shared-id".into()).unwrap();
        let terminal =
            terminal_stream_key(format!("device-a-{suffix}"), &base, "shared-id").unwrap();
        assert_ne!(agent, terminal);
        let (_, agent_cancelled) = install_stream(agent.clone()).unwrap();
        let (_, mut terminal_cancelled) = install_stream(terminal.clone()).unwrap();

        cancel_stream(&agent, None).unwrap();
        assert!(agent_cancelled.await.is_ok());
        assert!(matches!(
            terminal_cancelled.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        cancel_stream(&terminal, None).unwrap();
        assert!(terminal_cancelled.await.is_ok());
    }
}
