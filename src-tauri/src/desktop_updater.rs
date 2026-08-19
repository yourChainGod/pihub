#[path = "desktop_updater_security.rs"]
mod security;

use security::{SecureUpdateCheck, VerifiedDesktopArtifact};
use std::{
    future,
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::Update;

pub const DESKTOP_UPDATE_EVENT: &str = "pihub-desktop-update";
pub const DESKTOP_UPDATER_ENDPOINT: &str =
    "https://github.com/yourChainGod/pihub/releases/latest/download/pihub-desktop-v1.json";
pub const DESKTOP_UPDATER_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEU4OTk1MzI4ODJFMjMyRApSV1F0SXk2SU1wV0pEampHUEF0RnYxSTltOTM2Z0x1L0RUY0ZDaFlrcDBpWFNHUFkveU5NaDRuOQo=";

const PROGRESS_EVENT_INTERVAL_BYTES: u64 = 256 * 1024;

#[derive(Clone)]
struct PendingDesktopUpdate {
    update: Update,
    artifact: VerifiedDesktopArtifact,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct DesktopUpdateFailure {
    pub(super) code: &'static str,
    pub(super) message: &'static str,
}

impl DesktopUpdateFailure {
    pub(super) const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopUpdatePhase {
    Idle,
    Checking,
    Available,
    UpToDate,
    Downloading,
    Verifying,
    Installing,
    ReadyToRestart,
    Restarting,
    Failed,
}

impl DesktopUpdatePhase {
    fn is_busy(self) -> bool {
        matches!(
            self,
            Self::Checking
                | Self::Downloading
                | Self::Verifying
                | Self::Installing
                | Self::Restarting
        )
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateSnapshot {
    phase: DesktopUpdatePhase,
    current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    available_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checked_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateCommandError {
    code: &'static str,
    message: &'static str,
}

impl DesktopUpdateCommandError {
    fn busy() -> Self {
        Self {
            code: "updateBusy",
            message: "另一个桌面更新操作正在进行。",
        }
    }

    fn restart_required() -> Self {
        Self {
            code: "restartRequired",
            message: "更新已安装，请先重启 PiHub。",
        }
    }

    fn update_not_installed() -> Self {
        Self {
            code: "updateNotInstalled",
            message: "尚无已安装并等待重启的桌面更新。",
        }
    }

    fn no_update() -> Self {
        Self {
            code: "noCheckedUpdate",
            message: "请先检查并确认有可用的桌面更新。",
        }
    }

    fn not_cancellable() -> Self {
        Self {
            code: "updateNotCancellable",
            message: "当前没有可取消的更新下载。",
        }
    }
}

struct DesktopUpdaterInner {
    snapshot: DesktopUpdateSnapshot,
    pending_update: Option<PendingDesktopUpdate>,
    cancel_sender: Option<tokio::sync::watch::Sender<bool>>,
    last_emitted_bytes: u64,
}

#[derive(Clone)]
pub struct DesktopUpdaterState {
    inner: Arc<Mutex<DesktopUpdaterInner>>,
}

impl DesktopUpdaterState {
    pub fn new(current_version: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(DesktopUpdaterInner {
                snapshot: DesktopUpdateSnapshot {
                    phase: DesktopUpdatePhase::Idle,
                    current_version: current_version.into(),
                    available_version: None,
                    downloaded_bytes: None,
                    total_bytes: None,
                    checked_at: None,
                    error_code: None,
                    error_message: None,
                },
                pending_update: None,
                cancel_sender: None,
                last_emitted_bytes: 0,
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, DesktopUpdaterInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn snapshot(&self) -> DesktopUpdateSnapshot {
        self.lock().snapshot.clone()
    }

    fn begin_check(&self) -> Result<DesktopUpdateSnapshot, DesktopUpdateCommandError> {
        let mut inner = self.lock();
        if inner.snapshot.phase.is_busy() {
            return Err(DesktopUpdateCommandError::busy());
        }
        if inner.snapshot.phase == DesktopUpdatePhase::ReadyToRestart {
            return Err(DesktopUpdateCommandError::restart_required());
        }
        inner.pending_update = None;
        inner.cancel_sender = None;
        inner.last_emitted_bytes = 0;
        inner.snapshot.phase = DesktopUpdatePhase::Checking;
        inner.snapshot.available_version = None;
        inner.snapshot.downloaded_bytes = None;
        inner.snapshot.total_bytes = None;
        inner.snapshot.error_code = None;
        inner.snapshot.error_message = None;
        Ok(inner.snapshot.clone())
    }

    fn update_available(&self, pending: PendingDesktopUpdate) -> DesktopUpdateSnapshot {
        let mut inner = self.lock();
        inner.snapshot.phase = DesktopUpdatePhase::Available;
        inner.snapshot.available_version = Some(pending.update.version.clone());
        inner.snapshot.checked_at = Some(now_millis());
        inner.snapshot.error_code = None;
        inner.snapshot.error_message = None;
        inner.pending_update = Some(pending);
        inner.cancel_sender = None;
        inner.snapshot.clone()
    }

    fn up_to_date(&self) -> DesktopUpdateSnapshot {
        let mut inner = self.lock();
        inner.snapshot.phase = DesktopUpdatePhase::UpToDate;
        inner.snapshot.available_version = None;
        inner.snapshot.checked_at = Some(now_millis());
        inner.snapshot.error_code = None;
        inner.snapshot.error_message = None;
        inner.pending_update = None;
        inner.cancel_sender = None;
        inner.snapshot.clone()
    }

    fn begin_install(
        &self,
    ) -> Result<
        (
            PendingDesktopUpdate,
            tokio::sync::watch::Receiver<bool>,
            DesktopUpdateSnapshot,
        ),
        DesktopUpdateCommandError,
    > {
        let mut inner = self.lock();
        if inner.snapshot.phase.is_busy() {
            return Err(DesktopUpdateCommandError::busy());
        }
        if inner.snapshot.phase == DesktopUpdatePhase::ReadyToRestart {
            return Err(DesktopUpdateCommandError::restart_required());
        }
        let pending = inner
            .pending_update
            .clone()
            .ok_or_else(DesktopUpdateCommandError::no_update)?;
        let (cancel_sender, cancel_receiver) = tokio::sync::watch::channel(false);
        inner.cancel_sender = Some(cancel_sender);
        inner.snapshot.phase = DesktopUpdatePhase::Downloading;
        inner.snapshot.downloaded_bytes = Some(0);
        inner.snapshot.total_bytes = Some(pending.artifact.size);
        inner.snapshot.error_code = None;
        inner.snapshot.error_message = None;
        inner.last_emitted_bytes = 0;
        Ok((pending, cancel_receiver, inner.snapshot.clone()))
    }

    fn add_download_progress(&self, chunk_bytes: usize) -> Option<DesktopUpdateSnapshot> {
        let mut inner = self.lock();
        if inner.snapshot.phase != DesktopUpdatePhase::Downloading {
            return None;
        }
        let downloaded = inner
            .snapshot
            .downloaded_bytes
            .unwrap_or_default()
            .saturating_add(u64::try_from(chunk_bytes).unwrap_or(u64::MAX));
        inner.snapshot.downloaded_bytes = Some(downloaded);
        let finished = inner
            .snapshot
            .total_bytes
            .is_some_and(|total| downloaded >= total);
        if !finished
            && downloaded.saturating_sub(inner.last_emitted_bytes) < PROGRESS_EVENT_INTERVAL_BYTES
        {
            return None;
        }
        inner.last_emitted_bytes = downloaded;
        Some(inner.snapshot.clone())
    }

    fn begin_verification(&self) -> DesktopUpdateSnapshot {
        let mut inner = self.lock();
        inner.snapshot.phase = DesktopUpdatePhase::Verifying;
        inner.snapshot.clone()
    }

    fn begin_package_install(&self) -> DesktopUpdateSnapshot {
        let mut inner = self.lock();
        inner.snapshot.phase = DesktopUpdatePhase::Installing;
        inner.cancel_sender = None;
        inner.snapshot.clone()
    }

    fn install_complete(&self) -> DesktopUpdateSnapshot {
        let mut inner = self.lock();
        inner.snapshot.phase = DesktopUpdatePhase::ReadyToRestart;
        inner.snapshot.error_code = None;
        inner.snapshot.error_message = None;
        inner.pending_update = None;
        inner.cancel_sender = None;
        inner.snapshot.clone()
    }

    fn fail(&self, failure: DesktopUpdateFailure, keep_pending: bool) -> DesktopUpdateSnapshot {
        let mut inner = self.lock();
        inner.snapshot.phase = DesktopUpdatePhase::Failed;
        inner.snapshot.error_code = Some(failure.code.to_owned());
        inner.snapshot.error_message = Some(failure.message.to_owned());
        if !keep_pending {
            inner.pending_update = None;
            inner.snapshot.available_version = None;
        }
        inner.cancel_sender = None;
        inner.snapshot.clone()
    }

    fn request_cancel(&self) -> Result<DesktopUpdateSnapshot, DesktopUpdateCommandError> {
        let inner = self.lock();
        if inner.snapshot.phase != DesktopUpdatePhase::Downloading {
            return Err(DesktopUpdateCommandError::not_cancellable());
        }
        let sender = inner
            .cancel_sender
            .as_ref()
            .ok_or_else(DesktopUpdateCommandError::not_cancellable)?;
        sender
            .send(true)
            .map_err(|_| DesktopUpdateCommandError::not_cancellable())?;
        Ok(inner.snapshot.clone())
    }

    fn begin_restart(&self) -> Result<DesktopUpdateSnapshot, DesktopUpdateCommandError> {
        let mut inner = self.lock();
        if inner.snapshot.phase != DesktopUpdatePhase::ReadyToRestart {
            return Err(DesktopUpdateCommandError::update_not_installed());
        }
        inner.snapshot.phase = DesktopUpdatePhase::Restarting;
        Ok(inner.snapshot.clone())
    }
}

pub fn pinned_public_key() -> &'static str {
    DESKTOP_UPDATER_PUBLIC_KEY
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn emit_snapshot(app: &AppHandle, snapshot: &DesktopUpdateSnapshot) {
    let _ = app.emit(DESKTOP_UPDATE_EVENT, snapshot);
}

fn updater_install_failure(error: &tauri_plugin_updater::Error) -> DesktopUpdateFailure {
    use tauri_plugin_updater::Error;

    match error {
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) => {
            DesktopUpdateFailure::new(
                "signatureVerificationFailed",
                "更新包签名校验失败，安装已中止。",
            )
        }
        Error::Reqwest(error) if error.is_timeout() => {
            DesktopUpdateFailure::new("updateDownloadTimeout", "更新包下载超时，可稍后重新尝试。")
        }
        Error::Reqwest(_) | Error::Network(_) => {
            DesktopUpdateFailure::new("networkError", "无法连接 GitHub Releases，请稍后重试。")
        }
        _ => DesktopUpdateFailure::new("installFailed", "更新包安装失败，现有版本未重启。"),
    }
}

async fn wait_for_cancel(receiver: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *receiver.borrow_and_update() {
            return;
        }
        if receiver.changed().await.is_err() {
            future::pending::<()>().await;
        }
    }
}

enum DownloadOutcome {
    Complete(Result<Vec<u8>, tauri_plugin_updater::Error>),
    Aborted(DesktopUpdateFailure),
}

#[tauri::command]
pub fn desktop_update_status(state: State<'_, DesktopUpdaterState>) -> DesktopUpdateSnapshot {
    state.snapshot()
}

#[tauri::command]
pub async fn desktop_update_check(
    app: AppHandle,
    state: State<'_, DesktopUpdaterState>,
) -> Result<DesktopUpdateSnapshot, DesktopUpdateCommandError> {
    let started = state.begin_check()?;
    emit_snapshot(&app, &started);

    let snapshot = match security::secure_update_check(&app, &started.current_version).await {
        Ok(SecureUpdateCheck::UpToDate) => state.up_to_date(),
        Ok(SecureUpdateCheck::Available { update, artifact }) => {
            state.update_available(PendingDesktopUpdate {
                update: *update,
                artifact,
            })
        }
        Err(failure) => state.fail(failure, false),
    };
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub async fn desktop_update_install(
    app: AppHandle,
    state: State<'_, DesktopUpdaterState>,
) -> Result<DesktopUpdateSnapshot, DesktopUpdateCommandError> {
    let (pending, mut cancel_receiver, started) = state.begin_install()?;
    emit_snapshot(&app, &started);

    let progress_state = state.clone();
    let progress_app = app.clone();
    let verification_state = state.clone();
    let verification_app = app.clone();
    let signed_size = pending.artifact.size;
    let (failure_sender, failure_receiver) = tokio::sync::oneshot::channel();
    let mut failure_sender = Some(failure_sender);
    let mut observed_bytes = 0u64;
    let download = pending.update.download(
        move |chunk_bytes, declared_total| {
            observed_bytes =
                observed_bytes.saturating_add(u64::try_from(chunk_bytes).unwrap_or(u64::MAX));
            if let Some(failure) =
                security::streamed_download_failure(observed_bytes, declared_total, signed_size)
            {
                if let Some(sender) = failure_sender.take() {
                    let _ = sender.send(failure);
                }
            }
            if let Some(snapshot) = progress_state.add_download_progress(chunk_bytes) {
                emit_snapshot(&progress_app, &snapshot);
            }
        },
        move || {
            let snapshot = verification_state.begin_verification();
            emit_snapshot(&verification_app, &snapshot);
        },
    );
    tokio::pin!(download);

    let failure_signal = async move {
        match failure_receiver.await {
            Ok(failure) => failure,
            Err(_) => future::pending::<DesktopUpdateFailure>().await,
        }
    };
    tokio::pin!(failure_signal);
    let total_timeout = tokio::time::sleep(security::UPDATE_DOWNLOAD_TOTAL_TIMEOUT);
    tokio::pin!(total_timeout);
    let outcome = {
        let cancelled = wait_for_cancel(&mut cancel_receiver);
        tokio::pin!(cancelled);
        tokio::select! {
            biased;
            _ = &mut cancelled => DownloadOutcome::Aborted(DesktopUpdateFailure::new(
                "updateCancelled",
                "更新下载已取消，可重新尝试。",
            )),
            failure = &mut failure_signal => DownloadOutcome::Aborted(failure),
            _ = &mut total_timeout => DownloadOutcome::Aborted(DesktopUpdateFailure::new(
                "updateDownloadTimeout",
                "更新包下载超时，可稍后重新尝试。",
            )),
            result = &mut download => DownloadOutcome::Complete(result),
        }
    };

    let bytes = match outcome {
        DownloadOutcome::Complete(Ok(bytes)) => bytes,
        DownloadOutcome::Complete(Err(error)) => {
            let snapshot = state.fail(updater_install_failure(&error), true);
            emit_snapshot(&app, &snapshot);
            return Ok(snapshot);
        }
        DownloadOutcome::Aborted(failure) => {
            let snapshot = state.fail(failure, true);
            emit_snapshot(&app, &snapshot);
            return Ok(snapshot);
        }
    };

    if *cancel_receiver.borrow() {
        let snapshot = state.fail(
            DesktopUpdateFailure::new("updateCancelled", "更新下载已取消，可重新尝试。"),
            true,
        );
        emit_snapshot(&app, &snapshot);
        return Ok(snapshot);
    }
    if let Err(failure) = security::package_integrity_matches(&bytes, &pending.artifact) {
        let snapshot = state.fail(failure, true);
        emit_snapshot(&app, &snapshot);
        return Ok(snapshot);
    }

    let installing = state.begin_package_install();
    emit_snapshot(&app, &installing);
    let snapshot = match pending.update.install(bytes) {
        Ok(()) => state.install_complete(),
        Err(error) => state.fail(updater_install_failure(&error), true),
    };
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn desktop_update_cancel(
    app: AppHandle,
    state: State<'_, DesktopUpdaterState>,
) -> Result<DesktopUpdateSnapshot, DesktopUpdateCommandError> {
    let snapshot = state.request_cancel()?;
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn desktop_update_restart(
    app: AppHandle,
    state: State<'_, DesktopUpdaterState>,
) -> Result<DesktopUpdateSnapshot, DesktopUpdateCommandError> {
    let snapshot = state.begin_restart()?;
    emit_snapshot(&app, &snapshot);
    app.request_restart();
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_root_matches_the_committed_public_key() {
        assert_eq!(
            include_str!("../updater.pubkey").trim(),
            DESKTOP_UPDATER_PUBLIC_KEY
        );
    }

    #[test]
    fn restart_is_impossible_until_installation_completes() {
        let state = DesktopUpdaterState::new("0.0.1");
        let error = state.begin_restart().unwrap_err();
        assert_eq!(error.code, "updateNotInstalled");

        state.lock().snapshot.phase = DesktopUpdatePhase::ReadyToRestart;
        assert_eq!(
            state.begin_restart().unwrap().phase,
            DesktopUpdatePhase::Restarting
        );
    }

    #[test]
    fn concurrent_operations_are_rejected_without_resetting_progress() {
        let state = DesktopUpdaterState::new("0.0.1");
        assert_eq!(
            state.begin_check().unwrap().phase,
            DesktopUpdatePhase::Checking
        );
        assert_eq!(state.begin_check().unwrap_err().code, "updateBusy");
        assert!(matches!(state.begin_install(), Err(error) if error.code == "updateBusy"));
        assert_eq!(state.snapshot().phase, DesktopUpdatePhase::Checking);
    }

    #[test]
    fn progress_events_are_bounded_but_state_keeps_every_chunk() {
        let state = DesktopUpdaterState::new("0.0.1");
        {
            let mut inner = state.lock();
            inner.snapshot.phase = DesktopUpdatePhase::Downloading;
            inner.snapshot.downloaded_bytes = Some(0);
            inner.snapshot.total_bytes = Some(1024 * 1024);
        }
        assert!(state.add_download_progress(1024).is_none());
        assert!(state.add_download_progress(256 * 1024).is_some());
        assert_eq!(state.snapshot().downloaded_bytes, Some(263_168));
    }

    #[test]
    fn cancellation_is_only_available_during_an_active_download() {
        let state = DesktopUpdaterState::new("0.0.1");
        assert_eq!(
            state.request_cancel().unwrap_err().code,
            "updateNotCancellable"
        );
        let (sender, mut receiver) = tokio::sync::watch::channel(false);
        {
            let mut inner = state.lock();
            inner.snapshot.phase = DesktopUpdatePhase::Downloading;
            inner.cancel_sender = Some(sender);
        }
        state.request_cancel().unwrap();
        assert!(receiver.has_changed().unwrap());
        assert!(*receiver.borrow_and_update());
    }
}
