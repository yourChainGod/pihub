use super::{DesktopUpdateFailure, DESKTOP_UPDATER_ENDPOINT, DESKTOP_UPDATER_PUBLIC_KEY};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use percent_encoding::percent_decode_str;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::fd::AsRawFd as _;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};
#[cfg(windows)]
use std::os::windows::{ffi::OsStrExt as _, fs::OpenOptionsExt as _, io::AsRawHandle as _};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use time::{format_description::well_known::Rfc3339, OffsetDateTime, UtcOffset};
use url::Url;

pub(super) const DESKTOP_UPDATER_SIGNATURE_ENDPOINT: &str =
    "https://github.com/yourChainGod/pihub/releases/latest/download/pihub-desktop-v1.json.sig";

const RELEASE_REPOSITORY: &str = "yourChainGod/pihub";
const RELEASE_KIND: &str = "pihub.desktop-v1-update-manifest";
const RELEASE_CHANNEL: &str = "desktop-v1-stable";
const UPDATE_CHECK_TOTAL_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_CHECK_IDLE_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const UPDATE_DOWNLOAD_TOTAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const UPDATE_DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_UPDATE_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UPDATE_MANIFEST_BYTES: usize = 128 * 1024;
const MAX_UPDATE_MANIFEST_SIGNATURE_BYTES: usize = 16 * 1024;
const MAX_UPDATE_STATE_BYTES: u64 = 4 * 1024;
const MAX_UPDATE_REDIRECTS: usize = 5;
const MAX_PLATFORM_COUNT: usize = 32;
const MAX_TARGET_LENGTH: usize = 128;
const MAX_URL_LENGTH: usize = 2 * 1024;
const MAX_NOTES_LENGTH: usize = 32 * 1024;
const MAX_VERSION_LENGTH: usize = 64;
const MAX_ASSET_NAME_LENGTH: usize = 255;
const UPDATE_STATE_FILENAME: &str = "desktop-v1-updater-state.json";
const UPDATE_STATE_LOCK_FILENAME: &str = "desktop-v1-updater-state.lock";
const UPDATE_STATE_LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const MANIFEST_RANGE_HEADER: &str = "bytes=0-131071";

const INVALID_MANIFEST: DesktopUpdateFailure = DesktopUpdateFailure::new(
    "invalidReleaseManifest",
    "GitHub 更新清单无效，已拒绝此次更新。",
);
const INVALID_MANIFEST_SIGNATURE: DesktopUpdateFailure = DesktopUpdateFailure::new(
    "manifestSignatureVerificationFailed",
    "更新清单签名校验失败，已拒绝此次更新。",
);
const MANIFEST_TOO_LARGE: DesktopUpdateFailure =
    DesktopUpdateFailure::new("manifestTooLarge", "更新清单超过安全上限，已拒绝此次更新。");
const NETWORK_FAILURE: DesktopUpdateFailure =
    DesktopUpdateFailure::new("networkError", "无法安全连接 GitHub Releases，请稍后重试。");
const CHECK_TIMEOUT: DesktopUpdateFailure =
    DesktopUpdateFailure::new("updateCheckTimeout", "检查桌面更新超时，请稍后重试。");
const UNSUPPORTED_PLATFORM: DesktopUpdateFailure =
    DesktopUpdateFailure::new("unsupportedPlatform", "当前安装包类型没有可用的桌面更新。");
const INCONSISTENT_MANIFEST: DesktopUpdateFailure = DesktopUpdateFailure::new(
    "releaseManifestChanged",
    "更新清单在校验期间发生变化，已中止更新。",
);
const ROLLBACK_REJECTED: DesktopUpdateFailure = DesktopUpdateFailure::new(
    "updateRollbackRejected",
    "检测到旧版本更新清单，已阻止版本回退。",
);
const STATE_INVALID: DesktopUpdateFailure = DesktopUpdateFailure::new(
    "updateStateInvalid",
    "桌面更新安全状态损坏或不安全，已中止更新。",
);
const STATE_UNAVAILABLE: DesktopUpdateFailure = DesktopUpdateFailure::new(
    "updateStateUnavailable",
    "无法安全保存桌面更新状态，已中止更新。",
);

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct DesktopReleasePlatform {
    url: String,
    signature: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct DesktopReleaseIntegrity {
    target: String,
    sha256: String,
    size: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopReleaseSecurity {
    schema_version: u32,
    kind: String,
    repository: String,
    channel: String,
    tag: String,
    platforms: BTreeMap<String, DesktopReleaseIntegrity>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct DesktopReleaseManifest {
    version: String,
    notes: String,
    pub_date: String,
    platforms: BTreeMap<String, DesktopReleasePlatform>,
    pihub: DesktopReleaseSecurity,
}

#[derive(Clone, Debug)]
struct ValidatedDesktopManifest {
    manifest: DesktopReleaseManifest,
    raw_json: serde_json::Value,
    version: Version,
}

#[derive(Clone, Debug)]
pub(super) struct VerifiedDesktopArtifact {
    pub(super) target: String,
    pub(super) url: Url,
    pub(super) signature: String,
    pub(super) sha256: [u8; 32],
    pub(super) size: u64,
}

pub(super) enum SecureUpdateCheck {
    UpToDate,
    Available {
        update: Box<Update>,
        artifact: VerifiedDesktopArtifact,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopUpdatePersistentState {
    schema_version: u32,
    highest_accepted_version: String,
}

fn fixed_updater_endpoint() -> Url {
    Url::parse(DESKTOP_UPDATER_ENDPOINT).expect("compiled updater endpoint must be valid")
}

fn fixed_signature_endpoint() -> Url {
    Url::parse(DESKTOP_UPDATER_SIGNATURE_ENDPOINT)
        .expect("compiled updater signature endpoint must be valid")
}

fn canonical_version(value: &str) -> Result<Version, DesktopUpdateFailure> {
    if value.is_empty() || value.len() > MAX_VERSION_LENGTH || !value.is_ascii() {
        return Err(INVALID_MANIFEST);
    }
    let version = Version::parse(value).map_err(|_| INVALID_MANIFEST)?;
    if version.to_string() != value || !version.pre.is_empty() || !version.build.is_empty() {
        return Err(INVALID_MANIFEST);
    }
    Ok(version)
}

fn safe_target(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TARGET_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn safe_asset_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ASSET_NAME_LENGTH
        && !value.contains("..")
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'+' | b'-'))
        })
}

fn secure_https_url(url: &Url, allow_query: bool) -> bool {
    url.scheme() == "https"
        && !url.cannot_be_a_base()
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && (allow_query || url.query().is_none())
        && url.fragment().is_none()
}

fn canonical_release_asset_parts(url: &Url) -> Option<(Version, String)> {
    if !secure_https_url(url, false) || url.host_str() != Some("github.com") {
        return None;
    }
    let segments: Vec<_> = url.path_segments()?.collect();
    if segments.len() != 6
        || segments[..4] != ["yourChainGod", "pihub", "releases", "download"]
        || !segments[4].starts_with('v')
    {
        return None;
    }
    let version = canonical_version(&segments[4][1..]).ok()?;
    let asset = percent_decode_str(segments[5])
        .decode_utf8()
        .ok()?
        .into_owned();
    safe_asset_name(&asset).then_some((version, asset))
}

fn validate_release_asset_url(value: &str, version: &Version) -> Result<Url, DesktopUpdateFailure> {
    if value.is_empty() || value.len() > MAX_URL_LENGTH || !value.is_ascii() {
        return Err(INVALID_MANIFEST);
    }
    let url = Url::parse(value).map_err(|_| INVALID_MANIFEST)?;
    let (url_version, _) = canonical_release_asset_parts(&url).ok_or(INVALID_MANIFEST)?;
    if &url_version != version {
        return Err(INVALID_MANIFEST);
    }
    Ok(url)
}

fn trusted_github_release_url(url: &Url) -> bool {
    url.as_str() == DESKTOP_UPDATER_ENDPOINT
        || url.as_str() == DESKTOP_UPDATER_SIGNATURE_ENDPOINT
        || canonical_release_asset_parts(url).is_some()
}

fn trusted_release_cdn_url(url: &Url) -> bool {
    secure_https_url(url, true)
        && matches!(
            url.host_str(),
            Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com")
        )
        && url.path().starts_with('/')
        && url.path().len() > 1
}

fn redirect_hop_allowed(previous: &[Url], next: &Url) -> bool {
    if previous.is_empty() || previous.len() > MAX_UPDATE_REDIRECTS {
        return false;
    }
    let Some(current) = previous.last() else {
        return false;
    };
    trusted_github_release_url(current)
        && (trusted_github_release_url(next) || trusted_release_cdn_url(next))
}

fn strict_redirect_policy() -> reqwest_updater::redirect::Policy {
    reqwest_updater::redirect::Policy::custom(|attempt| {
        if redirect_hop_allowed(attempt.previous(), attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("untrusted or excessive desktop updater redirect")
        }
    })
}

fn secure_client_builder(
    builder: reqwest_updater::ClientBuilder,
) -> reqwest_updater::ClientBuilder {
    builder
        .redirect(strict_redirect_policy())
        .connect_timeout(UPDATE_CHECK_IDLE_TIMEOUT)
        .read_timeout(UPDATE_DOWNLOAD_IDLE_TIMEOUT)
        .referer(false)
}

fn strip_one_line_ending(bytes: &[u8]) -> &[u8] {
    if let Some(stripped) = bytes.strip_suffix(b"\r\n") {
        stripped
    } else if let Some(stripped) = bytes.strip_suffix(b"\n") {
        stripped
    } else {
        bytes
    }
}

fn canonical_base64_decode(
    bytes: &[u8],
    allow_final_line_ending: bool,
) -> Result<Vec<u8>, DesktopUpdateFailure> {
    let encoded = if allow_final_line_ending {
        strip_one_line_ending(bytes)
    } else {
        bytes
    };
    let text = std::str::from_utf8(encoded).map_err(|_| INVALID_MANIFEST_SIGNATURE)?;
    if text.is_empty()
        || !text.is_ascii()
        || text
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte == 0)
    {
        return Err(INVALID_MANIFEST_SIGNATURE);
    }
    let decoded = BASE64_STANDARD
        .decode(text)
        .map_err(|_| INVALID_MANIFEST_SIGNATURE)?;
    if BASE64_STANDARD.encode(&decoded) != text {
        return Err(INVALID_MANIFEST_SIGNATURE);
    }
    Ok(decoded)
}

fn strict_minisign_text(
    decoded: &[u8],
    expected_lines: usize,
) -> Result<&str, DesktopUpdateFailure> {
    let decoded = strip_one_line_ending(decoded);
    let text = std::str::from_utf8(decoded).map_err(|_| INVALID_MANIFEST_SIGNATURE)?;
    if text.is_empty()
        || text.contains('\0')
        || text.contains('\r')
        || text
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(INVALID_MANIFEST_SIGNATURE);
    }
    let lines: Vec<_> = text.split('\n').collect();
    if lines.len() != expected_lines || lines.iter().any(|line| line.is_empty()) {
        return Err(INVALID_MANIFEST_SIGNATURE);
    }
    if !lines[0].starts_with("untrusted comment:") {
        return Err(INVALID_MANIFEST_SIGNATURE);
    }
    canonical_base64_decode(lines[1].as_bytes(), false)?;
    if expected_lines == 4 {
        if !lines[2].starts_with("trusted comment:") {
            return Err(INVALID_MANIFEST_SIGNATURE);
        }
        canonical_base64_decode(lines[3].as_bytes(), false)?;
    }
    Ok(text)
}

fn decode_public_key(encoded: &[u8]) -> Result<PublicKey, DesktopUpdateFailure> {
    let decoded = canonical_base64_decode(encoded, true)?;
    let text = strict_minisign_text(&decoded, 2)?;
    PublicKey::decode(text).map_err(|_| INVALID_MANIFEST_SIGNATURE)
}

fn decode_signature(encoded: &[u8]) -> Result<Signature, DesktopUpdateFailure> {
    if encoded.len() > MAX_UPDATE_MANIFEST_SIGNATURE_BYTES {
        return Err(INVALID_MANIFEST_SIGNATURE);
    }
    let decoded = canonical_base64_decode(encoded, true)?;
    let text = strict_minisign_text(&decoded, 4)?;
    Signature::decode(text).map_err(|_| INVALID_MANIFEST_SIGNATURE)
}

fn verify_detached_manifest_signature_with_key(
    manifest: &[u8],
    encoded_signature: &[u8],
    encoded_public_key: &[u8],
) -> Result<(), DesktopUpdateFailure> {
    let public_key = decode_public_key(encoded_public_key)?;
    let signature = decode_signature(encoded_signature)?;
    public_key
        .verify(manifest, &signature, false)
        .map_err(|_| INVALID_MANIFEST_SIGNATURE)
}

fn verify_detached_manifest_signature(
    manifest: &[u8],
    encoded_signature: &[u8],
) -> Result<(), DesktopUpdateFailure> {
    verify_detached_manifest_signature_with_key(
        manifest,
        encoded_signature,
        DESKTOP_UPDATER_PUBLIC_KEY.as_bytes(),
    )
}

fn validate_artifact_signature(value: &str) -> Result<(), DesktopUpdateFailure> {
    decode_signature(value.as_bytes()).map(|_| ())
}

fn validate_manifest(
    raw_manifest: &[u8],
    selected_target: &str,
) -> Result<(ValidatedDesktopManifest, VerifiedDesktopArtifact), DesktopUpdateFailure> {
    if raw_manifest.is_empty() || raw_manifest.len() > MAX_UPDATE_MANIFEST_BYTES {
        return Err(MANIFEST_TOO_LARGE);
    }
    if !safe_target(selected_target) {
        return Err(UNSUPPORTED_PLATFORM);
    }
    let manifest: DesktopReleaseManifest =
        serde_json::from_slice(raw_manifest).map_err(|_| INVALID_MANIFEST)?;
    let raw_json = serde_json::from_slice(raw_manifest).map_err(|_| INVALID_MANIFEST)?;
    let version = canonical_version(&manifest.version)?;
    if manifest.notes.len() > MAX_NOTES_LENGTH
        || manifest.notes.contains('\0')
        || manifest.pub_date.len() > 64
    {
        return Err(INVALID_MANIFEST);
    }
    let published =
        OffsetDateTime::parse(&manifest.pub_date, &Rfc3339).map_err(|_| INVALID_MANIFEST)?;
    if published.offset() != UtcOffset::UTC {
        return Err(INVALID_MANIFEST);
    }
    if manifest.pihub.schema_version != 1
        || manifest.pihub.kind != RELEASE_KIND
        || manifest.pihub.repository != RELEASE_REPOSITORY
        || manifest.pihub.channel != RELEASE_CHANNEL
        || manifest.pihub.tag != format!("v{version}")
        || manifest.platforms.is_empty()
        || manifest.platforms.len() > MAX_PLATFORM_COUNT
        || manifest.pihub.platforms.len() != manifest.platforms.len()
    {
        return Err(INVALID_MANIFEST);
    }
    let release_targets: BTreeSet<_> = manifest.platforms.keys().collect();
    let integrity_targets: BTreeSet<_> = manifest.pihub.platforms.keys().collect();
    if release_targets != integrity_targets {
        return Err(INVALID_MANIFEST);
    }

    let mut selected = None;
    for (target, platform) in &manifest.platforms {
        if !safe_target(target) {
            return Err(INVALID_MANIFEST);
        }
        let integrity = manifest
            .pihub
            .platforms
            .get(target)
            .ok_or(INVALID_MANIFEST)?;
        if integrity.target != *target
            || integrity.size == 0
            || integrity.size > MAX_UPDATE_DOWNLOAD_BYTES
            || integrity.sha256.len() != 64
            || !integrity
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(INVALID_MANIFEST);
        }
        validate_artifact_signature(&platform.signature)?;
        let url = validate_release_asset_url(&platform.url, &version)?;
        if target == selected_target {
            let mut digest = [0u8; 32];
            hex::decode_to_slice(&integrity.sha256, &mut digest).map_err(|_| INVALID_MANIFEST)?;
            selected = Some(VerifiedDesktopArtifact {
                target: target.clone(),
                url,
                signature: platform.signature.clone(),
                sha256: digest,
                size: integrity.size,
            });
        }
    }
    let artifact = selected.ok_or(UNSUPPORTED_PLATFORM)?;
    Ok((
        ValidatedDesktopManifest {
            manifest,
            raw_json,
            version,
        },
        artifact,
    ))
}

fn exact_target_for_bundle(base: &str, bundle: tauri::utils::config::BundleType) -> String {
    use tauri::utils::config::BundleType;

    let suffix = match bundle {
        BundleType::Deb => "deb",
        BundleType::Rpm => "rpm",
        BundleType::AppImage => "appimage",
        BundleType::Msi => "msi",
        BundleType::Nsis => "nsis",
        BundleType::App | BundleType::Dmg => "app",
    };
    format!("{base}-{suffix}")
}

fn current_exact_target() -> Result<String, DesktopUpdateFailure> {
    let base = tauri_plugin_updater::target().ok_or(UNSUPPORTED_PLATFORM)?;
    let bundle = tauri::utils::platform::bundle_type().ok_or(UNSUPPORTED_PLATFORM)?;
    Ok(exact_target_for_bundle(&base, bundle))
}

async fn fetch_bounded(
    client: &reqwest_updater::Client,
    url: Url,
    maximum_bytes: usize,
    too_large: DesktopUpdateFailure,
    accept: &'static str,
) -> Result<Vec<u8>, DesktopUpdateFailure> {
    let mut response = client
        .get(url)
        .header(reqwest_updater::header::ACCEPT, accept)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                CHECK_TIMEOUT
            } else {
                NETWORK_FAILURE
            }
        })?;
    if !response.status().is_success() {
        return Err(NETWORK_FAILURE);
    }
    if response
        .content_length()
        .is_some_and(|length| length > maximum_bytes as u64)
    {
        return Err(too_large);
    }
    if !trusted_github_release_url(response.url()) && !trusted_release_cdn_url(response.url()) {
        return Err(NETWORK_FAILURE);
    }
    let mut bytes = Vec::new();
    loop {
        let chunk = tokio::time::timeout(UPDATE_CHECK_IDLE_TIMEOUT, response.chunk())
            .await
            .map_err(|_| CHECK_TIMEOUT)?
            .map_err(|error| {
                if error.is_timeout() {
                    CHECK_TIMEOUT
                } else {
                    NETWORK_FAILURE
                }
            })?;
        let Some(chunk) = chunk else {
            break;
        };
        if bytes.len().saturating_add(chunk.len()) > maximum_bytes {
            return Err(too_large);
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(NETWORK_FAILURE);
    }
    Ok(bytes)
}

async fn fetch_and_verify_manifest(
    target: &str,
) -> Result<(ValidatedDesktopManifest, VerifiedDesktopArtifact), DesktopUpdateFailure> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = secure_client_builder(reqwest_updater::Client::builder())
        .timeout(UPDATE_CHECK_TOTAL_TIMEOUT)
        .build()
        .map_err(|_| NETWORK_FAILURE)?;
    let fetches = async {
        tokio::try_join!(
            fetch_bounded(
                &client,
                fixed_updater_endpoint(),
                MAX_UPDATE_MANIFEST_BYTES,
                MANIFEST_TOO_LARGE,
                "application/json",
            ),
            fetch_bounded(
                &client,
                fixed_signature_endpoint(),
                MAX_UPDATE_MANIFEST_SIGNATURE_BYTES,
                INVALID_MANIFEST_SIGNATURE,
                "application/octet-stream",
            )
        )
    };
    let (manifest, signature) = tokio::time::timeout(UPDATE_CHECK_TOTAL_TIMEOUT, fetches)
        .await
        .map_err(|_| CHECK_TIMEOUT)??;
    verify_detached_manifest_signature(&manifest, &signature)?;
    validate_manifest(&manifest, target)
}

fn second_fetch_matches(
    validated: &ValidatedDesktopManifest,
    artifact: &VerifiedDesktopArtifact,
    version: &str,
    target: &str,
    download_url: &Url,
    signature: &str,
    raw_json: &serde_json::Value,
) -> bool {
    version == validated.manifest.version
        && target == artifact.target
        && download_url == &artifact.url
        && signature == artifact.signature
        && raw_json == &validated.raw_json
}

async fn refetch_with_tauri(
    app: &AppHandle,
    validated: &ValidatedDesktopManifest,
    artifact: &VerifiedDesktopArtifact,
) -> Result<Update, DesktopUpdateFailure> {
    let expected_version = validated.version.clone();
    let builder = app
        .updater_builder()
        .clear_headers()
        .target(artifact.target.clone())
        .pubkey(DESKTOP_UPDATER_PUBLIC_KEY)
        .timeout(UPDATE_CHECK_TOTAL_TIMEOUT)
        .configure_client(secure_client_builder)
        .version_comparator(move |_, release| release.version == expected_version);
    let builder = builder
        .endpoints(vec![fixed_updater_endpoint()])
        .map_err(|_| INVALID_MANIFEST)?
        .header(reqwest_updater::header::RANGE, MANIFEST_RANGE_HEADER)
        .map_err(|_| INVALID_MANIFEST)?;
    let updater = builder
        .build()
        .map_err(|error| updater_check_failure(&error))?;
    let result = tokio::time::timeout(UPDATE_CHECK_TOTAL_TIMEOUT, updater.check())
        .await
        .map_err(|_| CHECK_TIMEOUT)?
        .map_err(|error| updater_check_failure(&error))?;
    let mut update = result.ok_or(INCONSISTENT_MANIFEST)?;
    if !second_fetch_matches(
        validated,
        artifact,
        &update.version,
        &update.target,
        &update.download_url,
        &update.signature,
        &update.raw_json,
    ) {
        return Err(INCONSISTENT_MANIFEST);
    }
    update.headers.remove(reqwest_updater::header::RANGE);
    update.timeout = Some(UPDATE_DOWNLOAD_TOTAL_TIMEOUT);
    Ok(update)
}

fn updater_check_failure(error: &tauri_plugin_updater::Error) -> DesktopUpdateFailure {
    use tauri_plugin_updater::Error;

    match error {
        Error::Reqwest(error) if error.is_timeout() => CHECK_TIMEOUT,
        Error::Reqwest(_) | Error::Network(_) => NETWORK_FAILURE,
        Error::UnsupportedArch
        | Error::UnsupportedOs
        | Error::TargetNotFound(_)
        | Error::TargetsNotFound(_) => UNSUPPORTED_PLATFORM,
        _ => INVALID_MANIFEST,
    }
}

pub(super) async fn secure_update_check(
    app: &AppHandle,
    current_version: &str,
) -> Result<SecureUpdateCheck, DesktopUpdateFailure> {
    let current = canonical_version(current_version).map_err(|_| STATE_INVALID)?;
    let target = current_exact_target()?;
    let (validated, artifact) = fetch_and_verify_manifest(&target).await?;
    let update = refetch_with_tauri(app, &validated, &artifact).await?;
    let config_directory = app.path().app_config_dir().map_err(|_| STATE_UNAVAILABLE)?;
    let candidate = validated.version.clone();
    let current_for_state = current.clone();
    tauri::async_runtime::spawn_blocking(move || {
        advance_highest_accepted_version(&config_directory, &current_for_state, &candidate)
    })
    .await
    .map_err(|_| STATE_UNAVAILABLE)??;
    if validated.version <= current {
        Ok(SecureUpdateCheck::UpToDate)
    } else {
        Ok(SecureUpdateCheck::Available {
            update: Box::new(update),
            artifact,
        })
    }
}

pub(super) fn package_integrity_matches(
    bytes: &[u8],
    artifact: &VerifiedDesktopArtifact,
) -> Result<(), DesktopUpdateFailure> {
    if bytes.len() as u64 > MAX_UPDATE_DOWNLOAD_BYTES {
        return Err(DesktopUpdateFailure::new(
            "updateTooLarge",
            "更新包超过 512 MiB 安全上限，下载已中止。",
        ));
    }
    if bytes.len() as u64 != artifact.size {
        return Err(DesktopUpdateFailure::new(
            "updateSizeMismatch",
            "更新包大小与签名清单不一致，安装已中止。",
        ));
    }
    let digest = Sha256::digest(bytes);
    if digest.as_slice() != artifact.sha256 {
        return Err(DesktopUpdateFailure::new(
            "updateHashMismatch",
            "更新包哈希与签名清单不一致，安装已中止。",
        ));
    }
    Ok(())
}

pub(super) fn streamed_download_failure(
    downloaded: u64,
    declared_total: Option<u64>,
    signed_total: u64,
) -> Option<DesktopUpdateFailure> {
    if downloaded > MAX_UPDATE_DOWNLOAD_BYTES
        || declared_total.is_some_and(|total| total > MAX_UPDATE_DOWNLOAD_BYTES)
    {
        return Some(DesktopUpdateFailure::new(
            "updateTooLarge",
            "更新包超过 512 MiB 安全上限，下载已中止。",
        ));
    }
    if downloaded > signed_total || declared_total.is_some_and(|total| total != signed_total) {
        return Some(DesktopUpdateFailure::new(
            "updateSizeMismatch",
            "更新包大小与签名清单不一致，下载已中止。",
        ));
    }
    None
}

fn safe_regular_metadata(metadata: &fs::Metadata) -> bool {
    if crate::metadata_is_link_like(metadata) || !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        metadata.nlink() == 1
    }
    #[cfg(not(unix))]
    true
}

struct StateFileLock {
    file: File,
}

#[cfg(unix)]
impl Drop for StateFileLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[cfg(windows)]
impl Drop for StateFileLock {
    fn drop(&mut self) {
        use windows_sys::Win32::{Storage::FileSystem::UnlockFileEx, System::IO::OVERLAPPED};

        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        unsafe {
            UnlockFileEx(
                self.file.as_raw_handle().cast(),
                0,
                u32::MAX,
                u32::MAX,
                &mut overlapped,
            );
        }
    }
}

fn private_open_options(read: bool, write: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(read).write(write);
    #[cfg(unix)]
    options
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    #[cfg(windows)]
    options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    options
}

fn acquire_state_file_lock(directory: &Path) -> Result<StateFileLock, DesktopUpdateFailure> {
    crate::ensure_private_directory(directory).map_err(|_| STATE_UNAVAILABLE)?;
    let path = directory.join(UPDATE_STATE_LOCK_FILENAME);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(STATE_UNAVAILABLE),
        Ok(metadata) if !safe_regular_metadata(&metadata) => return Err(STATE_INVALID),
        Ok(_) => {}
    }
    let mut options = private_open_options(true, true);
    options.create(true);
    let file = options.open(&path).map_err(|_| STATE_UNAVAILABLE)?;
    let metadata = file.metadata().map_err(|_| STATE_UNAVAILABLE)?;
    if !safe_regular_metadata(&metadata) {
        return Err(STATE_INVALID);
    }
    crate::tighten_private_file(&file, &path).map_err(|_| STATE_UNAVAILABLE)?;
    let deadline = Instant::now() + UPDATE_STATE_LOCK_TIMEOUT;

    #[cfg(unix)]
    loop {
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result == 0 {
            break;
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::WouldBlock || Instant::now() >= deadline {
            return Err(STATE_UNAVAILABLE);
        }
        thread::sleep(Duration::from_millis(20));
    }

    #[cfg(windows)]
    loop {
        use windows_sys::Win32::{
            Foundation::GetLastError,
            Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY},
            System::IO::OVERLAPPED,
        };

        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        if unsafe {
            LockFileEx(
                file.as_raw_handle().cast(),
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                u32::MAX,
                u32::MAX,
                &mut overlapped,
            )
        } != 0
        {
            break;
        }
        let error = unsafe { GetLastError() };
        const ERROR_LOCK_VIOLATION: u32 = 33;
        if error != ERROR_LOCK_VIOLATION || Instant::now() >= deadline {
            return Err(STATE_UNAVAILABLE);
        }
        thread::sleep(Duration::from_millis(20));
    }

    Ok(StateFileLock { file })
}

fn read_persisted_version(path: &Path) -> Result<Option<Version>, DesktopUpdateFailure> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(STATE_UNAVAILABLE),
        Ok(metadata)
            if !safe_regular_metadata(&metadata)
                || metadata.len() == 0
                || metadata.len() > MAX_UPDATE_STATE_BYTES =>
        {
            return Err(STATE_INVALID)
        }
        Ok(_) => {}
    }
    let mut file = private_open_options(true, false)
        .open(path)
        .map_err(|_| STATE_UNAVAILABLE)?;
    let metadata = file.metadata().map_err(|_| STATE_UNAVAILABLE)?;
    if !safe_regular_metadata(&metadata)
        || metadata.len() == 0
        || metadata.len() > MAX_UPDATE_STATE_BYTES
    {
        return Err(STATE_INVALID);
    }
    crate::tighten_private_file(&file, path).map_err(|_| STATE_UNAVAILABLE)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_UPDATE_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| STATE_UNAVAILABLE)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_UPDATE_STATE_BYTES {
        return Err(STATE_INVALID);
    }
    let state: DesktopUpdatePersistentState =
        serde_json::from_slice(&bytes).map_err(|_| STATE_INVALID)?;
    if state.schema_version != 1 {
        return Err(STATE_INVALID);
    }
    canonical_version(&state.highest_accepted_version)
        .map(Some)
        .map_err(|_| STATE_INVALID)
}

fn create_state_temporary_file(directory: &Path) -> Result<(PathBuf, File), DesktopUpdateFailure> {
    static TEMPORARY_COUNTER: AtomicU64 = AtomicU64::new(0);

    for _ in 0..32 {
        let sequence = TEMPORARY_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!(
            ".{UPDATE_STATE_FILENAME}.{}.{}.tmp",
            std::process::id(),
            sequence
        ));
        let mut options = private_open_options(false, true);
        options.create_new(true);
        match options.open(&path) {
            Ok(file) => {
                if crate::tighten_private_file(&file, &path).is_err() {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(STATE_UNAVAILABLE);
                }
                return Ok((path, file));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(STATE_UNAVAILABLE),
        }
    }
    Err(STATE_UNAVAILABLE)
}

#[cfg(unix)]
fn replace_state_file(temporary: &Path, destination: &Path) -> Result<(), DesktopUpdateFailure> {
    fs::rename(temporary, destination).map_err(|_| STATE_UNAVAILABLE)?;
    let directory = destination.parent().ok_or(STATE_UNAVAILABLE)?;
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| STATE_UNAVAILABLE)
}

#[cfg(windows)]
fn replace_state_file(temporary: &Path, destination: &Path) -> Result<(), DesktopUpdateFailure> {
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temporary: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe {
        MoveFileExW(
            temporary.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(STATE_UNAVAILABLE);
    }
    Ok(())
}

fn write_persisted_version(path: &Path, version: &Version) -> Result<(), DesktopUpdateFailure> {
    let directory = path.parent().ok_or(STATE_UNAVAILABLE)?;
    crate::ensure_private_directory(directory).map_err(|_| STATE_UNAVAILABLE)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(STATE_UNAVAILABLE),
        Ok(metadata) if !safe_regular_metadata(&metadata) => return Err(STATE_INVALID),
        Ok(_) => {}
    }
    let state = DesktopUpdatePersistentState {
        schema_version: 1,
        highest_accepted_version: version.to_string(),
    };
    let mut data = serde_json::to_vec(&state).map_err(|_| STATE_UNAVAILABLE)?;
    data.push(b'\n');
    if data.len() as u64 > MAX_UPDATE_STATE_BYTES {
        return Err(STATE_UNAVAILABLE);
    }
    let (temporary_path, mut temporary) = create_state_temporary_file(directory)?;
    let result = (|| {
        temporary
            .write_all(&data)
            .and_then(|_| temporary.sync_all())
            .map_err(|_| STATE_UNAVAILABLE)?;
        drop(temporary);
        replace_state_file(&temporary_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn advance_highest_accepted_version(
    config_directory: &Path,
    current: &Version,
    candidate: &Version,
) -> Result<(), DesktopUpdateFailure> {
    let _lock = acquire_state_file_lock(config_directory)?;
    let state_path = config_directory.join(UPDATE_STATE_FILENAME);
    let persisted = read_persisted_version(&state_path)?;
    let baseline = persisted
        .as_ref()
        .filter(|version| *version > current)
        .unwrap_or(current);
    if candidate < baseline {
        return Err(ROLLBACK_REJECTED);
    }
    if persisted.as_ref() != Some(candidate) {
        write_persisted_version(&state_path, candidate)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const TEST_PUBLIC_KEY_LINE: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const TEST_PREHASHED_SIGNATURE_LINE: &str = concat!(
        "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/",
        "z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo="
    );
    const TEST_PREHASHED_GLOBAL_LINE: &str =
        "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";
    const TEST_LEGACY_SIGNATURE_LINE: &str =
        "RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=";
    const TEST_LEGACY_GLOBAL_LINE: &str =
        "QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";

    fn outer_base64(value: &str) -> String {
        BASE64_STANDARD.encode(value.as_bytes())
    }

    fn test_public_key() -> String {
        outer_base64(&format!(
            "untrusted comment: minisign public key E7620F1842B4E81F\n{TEST_PUBLIC_KEY_LINE}\n"
        ))
    }

    fn test_signature(prehashed: bool) -> String {
        let (signature, global, timestamp) = if prehashed {
            (
                TEST_PREHASHED_SIGNATURE_LINE,
                TEST_PREHASHED_GLOBAL_LINE,
                "1556193335",
            )
        } else {
            (
                TEST_LEGACY_SIGNATURE_LINE,
                TEST_LEGACY_GLOBAL_LINE,
                "1555779966",
            )
        };
        outer_base64(&format!(
            "untrusted comment: signature from minisign secret key\n{signature}\ntrusted comment: timestamp:{timestamp}\tfile:test\n{global}\n"
        ))
    }

    fn valid_manifest_value() -> Value {
        json!({
            "version": "0.0.2",
            "notes": "PiHub Desktop v0.0.2",
            "pub_date": "2026-08-19T00:00:00Z",
            "platforms": {
                "linux-x86_64-deb": {
                    "url": "https://github.com/yourChainGod/pihub/releases/download/v0.0.2/PiHub-Desktop_0.0.2_amd64.deb",
                    "signature": test_signature(false),
                }
            },
            "pihub": {
                "schemaVersion": 1,
                "kind": "pihub.desktop-v1-update-manifest",
                "repository": "yourChainGod/pihub",
                "channel": "desktop-v1-stable",
                "tag": "v0.0.2",
                "platforms": {
                    "linux-x86_64-deb": {
                        "target": "linux-x86_64-deb",
                        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
                        "size": 7
                    }
                }
            }
        })
    }

    fn manifest_bytes(value: &Value) -> Vec<u8> {
        serde_json::to_vec(value).unwrap()
    }

    fn temp_directory(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "pihub-updater-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn detached_manifest_signature_binds_every_raw_byte_and_rejects_legacy_mode() {
        let public_key = test_public_key();
        let signature = test_signature(true);
        verify_detached_manifest_signature_with_key(
            b"test",
            signature.as_bytes(),
            public_key.as_bytes(),
        )
        .unwrap();
        for changed in [b"Test".as_slice(), b"test\n".as_slice()] {
            assert!(verify_detached_manifest_signature_with_key(
                changed,
                signature.as_bytes(),
                public_key.as_bytes(),
            )
            .is_err());
        }
        assert!(verify_detached_manifest_signature_with_key(
            b"test",
            signature.as_bytes(),
            DESKTOP_UPDATER_PUBLIC_KEY.as_bytes(),
        )
        .is_err());
        assert!(verify_detached_manifest_signature_with_key(
            b"test",
            test_signature(false).as_bytes(),
            public_key.as_bytes(),
        )
        .is_err());
    }

    #[test]
    fn minisign_envelopes_require_canonical_base64_and_exact_line_counts() {
        assert!(canonical_base64_decode(b"-_8=", false).is_err());
        assert!(canonical_base64_decode(b"+/8", false).is_err());
        assert!(canonical_base64_decode(b"/x==", false).is_err());
        assert!(canonical_base64_decode(b" +/8=", false).is_err());

        let decoded = canonical_base64_decode(test_signature(true).as_bytes(), false).unwrap();
        let mut extra_line = String::from_utf8(decoded).unwrap();
        extra_line.push_str("unexpected\n");
        assert!(decode_signature(outer_base64(&extra_line).as_bytes()).is_err());
        let mut truncated = test_signature(true);
        truncated.pop();
        assert!(decode_signature(truncated.as_bytes()).is_err());
    }

    #[test]
    fn manifest_validation_binds_schema_tag_target_integrity_and_url() {
        let valid = valid_manifest_value();
        let (manifest, artifact) =
            validate_manifest(&manifest_bytes(&valid), "linux-x86_64-deb").unwrap();
        assert_eq!(manifest.version, Version::parse("0.0.2").unwrap());
        assert_eq!(artifact.target, "linux-x86_64-deb");
        assert_eq!(artifact.size, 7);

        let mut invalid_values = Vec::new();
        let mut value = valid.clone();
        value["pihub"]["schemaVersion"] = json!(2);
        invalid_values.push(value);
        let mut value = valid.clone();
        value["pihub"]["kind"] = json!("pihub.desktop-update-manifest");
        invalid_values.push(value);
        let mut value = valid.clone();
        value["pihub"]["channel"] = json!("stable");
        invalid_values.push(value);
        let mut value = valid.clone();
        value["pihub"]["tag"] = json!("v0.0.3");
        invalid_values.push(value);
        let mut value = valid.clone();
        value["version"] = json!("0.0.2-beta.1");
        invalid_values.push(value);
        let mut value = valid.clone();
        value["pihub"]["platforms"]["linux-x86_64-deb"]["target"] = json!("linux-x86_64");
        invalid_values.push(value);
        let mut value = valid.clone();
        value["pihub"]["platforms"]["linux-x86_64-deb"]["sha256"] = json!("A".repeat(64));
        invalid_values.push(value);
        let mut value = valid.clone();
        value["pihub"]["platforms"]["linux-x86_64-deb"]["size"] = json!(0);
        invalid_values.push(value);
        let mut value = valid.clone();
        value["platforms"]["linux-x86_64-deb"]["url"] =
            json!("https://evil.example/yourChainGod/pihub/releases/download/v0.0.2/PiHub-Desktop_0.0.2_amd64.deb");
        invalid_values.push(value);
        let mut value = valid.clone();
        value["platforms"]["linux-x86_64-deb"]["url"] = json!(
            "https://github.com/yourChainGod/pihub/releases/download/v0.0.2/PiHub-Desktop_0.0.2_amd64.deb?token=secret"
        );
        invalid_values.push(value);
        let mut value = valid.clone();
        value["unexpected"] = json!(true);
        invalid_values.push(value);

        for value in invalid_values {
            assert!(validate_manifest(&manifest_bytes(&value), "linux-x86_64-deb").is_err());
        }
        assert!(validate_manifest(&manifest_bytes(&valid), "linux-x86_64-appimage").is_err());
        assert!(validate_manifest(
            &vec![b' '; MAX_UPDATE_MANIFEST_BYTES + 1],
            "linux-x86_64-deb"
        )
        .is_err());
    }

    #[test]
    fn exact_bundle_target_never_falls_back_to_a_generic_artifact() {
        use tauri::utils::config::BundleType;

        assert_eq!(
            exact_target_for_bundle("linux-x86_64", BundleType::Deb),
            "linux-x86_64-deb"
        );
        assert_eq!(
            exact_target_for_bundle("linux-x86_64", BundleType::AppImage),
            "linux-x86_64-appimage"
        );
        assert_eq!(
            exact_target_for_bundle("windows-x86_64", BundleType::Nsis),
            "windows-x86_64-nsis"
        );
        assert_eq!(
            exact_target_for_bundle("darwin-aarch64", BundleType::Dmg),
            "darwin-aarch64-app"
        );
    }

    #[test]
    fn second_fetch_must_match_every_signed_update_field() {
        let bytes = manifest_bytes(&valid_manifest_value());
        let (validated, artifact) = validate_manifest(&bytes, "linux-x86_64-deb").unwrap();
        assert!(second_fetch_matches(
            &validated,
            &artifact,
            "0.0.2",
            &artifact.target,
            &artifact.url,
            &artifact.signature,
            &validated.raw_json,
        ));
        assert!(!second_fetch_matches(
            &validated,
            &artifact,
            "0.0.3",
            &artifact.target,
            &artifact.url,
            &artifact.signature,
            &validated.raw_json,
        ));
        assert!(!second_fetch_matches(
            &validated,
            &artifact,
            "0.0.2",
            "linux-x86_64",
            &artifact.url,
            &artifact.signature,
            &validated.raw_json,
        ));
        let changed_url =
            Url::parse("https://github.com/yourChainGod/pihub/releases/download/v0.0.2/Other.deb")
                .unwrap();
        assert!(!second_fetch_matches(
            &validated,
            &artifact,
            "0.0.2",
            &artifact.target,
            &changed_url,
            &artifact.signature,
            &validated.raw_json,
        ));
        let mut changed_json = validated.raw_json.clone();
        changed_json["notes"] = json!("changed");
        assert!(!second_fetch_matches(
            &validated,
            &artifact,
            "0.0.2",
            &artifact.target,
            &artifact.url,
            "changed",
            &changed_json,
        ));
    }

    #[test]
    fn package_size_and_sha256_are_checked_after_signature_verification() {
        let bytes = b"package";
        let artifact = VerifiedDesktopArtifact {
            target: "linux-x86_64-deb".into(),
            url: Url::parse(
                "https://github.com/yourChainGod/pihub/releases/download/v0.0.2/PiHub-Desktop_0.0.2_amd64.deb",
            )
            .unwrap(),
            signature: test_signature(false),
            sha256: Sha256::digest(bytes).into(),
            size: bytes.len() as u64,
        };
        package_integrity_matches(bytes, &artifact).unwrap();
        assert_eq!(
            package_integrity_matches(b"Package", &artifact)
                .unwrap_err()
                .code,
            "updateHashMismatch"
        );
        assert_eq!(
            package_integrity_matches(b"short", &artifact)
                .unwrap_err()
                .code,
            "updateSizeMismatch"
        );
        assert_eq!(
            streamed_download_failure(8, None, 7).unwrap().code,
            "updateSizeMismatch"
        );
        assert_eq!(
            streamed_download_failure(1, Some(8), 7).unwrap().code,
            "updateSizeMismatch"
        );
        assert_eq!(
            streamed_download_failure(MAX_UPDATE_DOWNLOAD_BYTES + 1, None, 7)
                .unwrap()
                .code,
            "updateTooLarge"
        );
    }

    #[test]
    fn redirects_are_limited_to_the_repository_and_one_terminal_github_cdn_hop() {
        let release =
            Url::parse("https://github.com/yourChainGod/pihub/releases/download/v0.0.2/PiHub-Desktop_0.0.2_amd64.deb")
                .unwrap();
        let cdn = Url::parse(
            "https://release-assets.githubusercontent.com/github-production-release-asset/1/file?sig=opaque",
        )
        .unwrap();
        assert!(redirect_hop_allowed(std::slice::from_ref(&release), &cdn));
        assert!(!redirect_hop_allowed(
            std::slice::from_ref(&release),
            &Url::parse("https://evil.example/file").unwrap()
        ));
        assert!(!redirect_hop_allowed(
            std::slice::from_ref(&release),
            &Url::parse("http://release-assets.githubusercontent.com/file").unwrap()
        ));
        assert!(!redirect_hop_allowed(std::slice::from_ref(&cdn), &release));
        assert!(!redirect_hop_allowed(
            &vec![release.clone(); MAX_UPDATE_REDIRECTS + 1],
            &cdn
        ));
    }

    #[test]
    fn desktop_v1_endpoints_reject_the_legacy_latest_manifest() {
        let manifest = fixed_updater_endpoint();
        let signature = fixed_signature_endpoint();
        let legacy = Url::parse(
            "https://github.com/yourChainGod/pihub/releases/latest/download/latest.json",
        )
        .unwrap();

        assert_eq!(manifest.as_str(), DESKTOP_UPDATER_ENDPOINT);
        assert_eq!(signature.as_str(), DESKTOP_UPDATER_SIGNATURE_ENDPOINT);
        assert!(trusted_github_release_url(&manifest));
        assert!(trusted_github_release_url(&signature));
        assert!(!trusted_github_release_url(&legacy));
        assert!(!redirect_hop_allowed(
            std::slice::from_ref(&legacy),
            &manifest
        ));
    }

    #[test]
    fn watermark_is_private_atomic_and_rejects_signed_rollback() {
        let directory = temp_directory("watermark");
        let current = Version::parse("0.0.1").unwrap();
        let next = Version::parse("0.0.2").unwrap();
        advance_highest_accepted_version(&directory, &current, &next).unwrap();
        let path = directory.join(UPDATE_STATE_FILENAME);
        assert_eq!(read_persisted_version(&path).unwrap(), Some(next.clone()));
        advance_highest_accepted_version(&directory, &current, &next).unwrap();
        assert_eq!(
            advance_highest_accepted_version(&directory, &current, &current)
                .unwrap_err()
                .code,
            "updateRollbackRejected"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(directory.join(UPDATE_STATE_LOCK_FILENAME))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn corrupt_or_oversized_watermark_fails_closed() {
        let directory = temp_directory("corrupt-watermark");
        crate::ensure_private_directory(&directory).unwrap();
        let path = directory.join(UPDATE_STATE_FILENAME);
        fs::write(&path, b"not-json").unwrap();
        assert_eq!(
            read_persisted_version(&path).unwrap_err().code,
            "updateStateInvalid"
        );
        File::create(&path)
            .unwrap()
            .set_len(MAX_UPDATE_STATE_BYTES + 1)
            .unwrap();
        assert_eq!(
            read_persisted_version(&path).unwrap_err().code,
            "updateStateInvalid"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn watermark_rejects_symlink_state_files() {
        use std::os::unix::fs::symlink;

        let directory = temp_directory("symlink-watermark");
        crate::ensure_private_directory(&directory).unwrap();
        let target = directory.join("target.json");
        fs::write(
            &target,
            b"{\"schemaVersion\":1,\"highestAcceptedVersion\":\"0.0.1\"}",
        )
        .unwrap();
        symlink(&target, directory.join(UPDATE_STATE_FILENAME)).unwrap();
        let error = advance_highest_accepted_version(
            &directory,
            &Version::parse("0.0.1").unwrap(),
            &Version::parse("0.0.2").unwrap(),
        )
        .unwrap_err();
        assert_eq!(error.code, "updateStateInvalid");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn concurrent_watermark_writers_can_only_move_forward() {
        let directory = temp_directory("concurrent-watermark");
        let current = Version::parse("0.0.1").unwrap();
        let mut writers = Vec::new();
        for patch in 2..=8 {
            let directory = directory.clone();
            let current = current.clone();
            writers.push(thread::spawn(move || {
                let candidate = Version::parse(&format!("0.0.{patch}")).unwrap();
                let result = advance_highest_accepted_version(&directory, &current, &candidate);
                assert!(result.is_ok() || result.unwrap_err() == ROLLBACK_REJECTED);
            }));
        }
        for writer in writers {
            writer.join().unwrap();
        }
        assert_eq!(
            read_persisted_version(&directory.join(UPDATE_STATE_FILENAME)).unwrap(),
            Some(Version::parse("0.0.8").unwrap())
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
