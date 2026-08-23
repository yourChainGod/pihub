use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::transport::{
    canonical_origin, is_base64url, local_unix_seconds, resolve_device_transport,
    response_bytes_limited, send_plain, validate_authentication_metadata, validate_tailnet_url,
    AuthenticatedRequestSpec, AuthenticationMetadata, DeviceTransport, MAX_AUTH_RESPONSE_BYTES,
    MAX_CLOCK_OFFSET_SECONDS,
};

pub(crate) const PIHUB_KEYRING_SERVICE: &str = "io.github.yourchaingod.pihub.desktop.auth.v1";
#[cfg(test)]
pub(crate) const LEGACY_DESKTOP_KEYRING_SERVICE: &str = "com.pihub.desktop.auth.v1";
pub(crate) const PIHUB_CREDENTIAL_VERSION: u8 = 1;
/// All device credentials live in a single keychain item. macOS gates keychain
/// access per item per binary, so one item per origin meant one password
/// prompt per device on every app rebuild; the merged store prompts at most
/// once. The username cannot collide with the legacy per-origin `origin-*`
/// usernames, which remain as the lazy-migration fallback.
pub(crate) const MERGED_STORE_USERNAME: &str = "devices-v2";
pub(crate) const MERGED_STORE_VERSION: u8 = 1;
/// Keychain username for the shared relay transport token (NATS account). The
/// token is transport-level only — end-to-end HMAC still gates every request.
pub(crate) const RELAY_TOKEN_USERNAME: &str = "relay-transport";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredCredential {
    pub(crate) version: u8,
    pub(crate) origin: String,
    pub(crate) device_id: String,
    pub(crate) secret: String,
    pub(crate) epoch: String,
    pub(crate) clock_offset_seconds: i64,
    pub(crate) timestamp_window_seconds: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MergedCredentialStore {
    version: u8,
    credentials: HashMap<String, StoredCredential>,
}

pub(crate) fn encode_merged_store(
    credentials: &HashMap<String, StoredCredential>,
) -> Result<String, String> {
    serde_json::to_string(&MergedCredentialStore {
        version: MERGED_STORE_VERSION,
        credentials: credentials.clone(),
    })
    .map_err(|_| "无法编码设备凭据".to_owned())
}

pub(crate) fn decode_merged_store(
    serialized: &str,
) -> Result<HashMap<String, StoredCredential>, String> {
    let store = serde_json::from_str::<MergedCredentialStore>(serialized)
        .map_err(|_| "系统凭据中的 PiHub 设备记录无效，请重新配对".to_owned())?;
    if store.version != MERGED_STORE_VERSION {
        return Err("系统凭据中的 PiHub 设备记录版本不受支持，请重新配对".into());
    }
    Ok(store.credentials)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialStatus {
    paired: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
}
pub(crate) fn validate_credential(
    credential: &StoredCredential,
    expected_origin: &str,
) -> Result<(), String> {
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

pub(crate) fn credential_username(origin: &str) -> String {
    format!("origin-{}", hex::encode(Sha256::digest(origin.as_bytes())))
}

pub(crate) fn credential_cache() -> &'static Mutex<HashMap<String, StoredCredential>> {
    static CACHE: OnceLock<Mutex<HashMap<String, StoredCredential>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn credential_store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn read_merged_store_from_keyring() -> Result<HashMap<String, StoredCredential>, String> {
    let entry = keyring::Entry::new(PIHUB_KEYRING_SERVICE, MERGED_STORE_USERNAME)
        .map_err(|_| "无法访问系统凭据存储")?;
    match entry.get_password() {
        Ok(serialized) => decode_merged_store(&serialized),
        Err(keyring::Error::NoEntry) => Ok(HashMap::new()),
        Err(_) => Err("无法读取系统凭据，请检查系统钥匙串或凭据管理器".into()),
    }
}

fn write_merged_store_to_keyring(
    credentials: &HashMap<String, StoredCredential>,
) -> Result<(), String> {
    let entry = keyring::Entry::new(PIHUB_KEYRING_SERVICE, MERGED_STORE_USERNAME)
        .map_err(|_| "无法访问系统凭据存储")?;
    entry
        .set_password(&encode_merged_store(credentials)?)
        .map_err(|_| "无法将设备密钥写入系统钥匙串或凭据管理器".to_owned())
}

fn read_legacy_credential_from_keyring(origin: &str) -> Result<Option<StoredCredential>, String> {
    let entry = keyring::Entry::new(PIHUB_KEYRING_SERVICE, &credential_username(origin))
        .map_err(|_| "无法访问系统凭据存储")?;
    match entry.get_password() {
        Ok(serialized) => {
            let credential = serde_json::from_str::<StoredCredential>(&serialized)
                .map_err(|_| "系统凭据中的 PiHub 设备记录无效，请重新配对".to_owned())?;
            Ok(Some(credential))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取系统凭据，请检查系统钥匙串或凭据管理器".into()),
    }
}

pub(crate) fn load_credential_from_keyring(
    origin: &str,
) -> Result<Option<StoredCredential>, String> {
    let _guard = credential_store_lock()
        .lock()
        .map_err(|_| "系统凭据存储暂时不可用")?;
    let mut store = read_merged_store_from_keyring()?;
    // Warm the process cache from the merged store so later origins never
    // touch the keychain again this run.
    if let Ok(mut cache) = credential_cache().lock() {
        for (cached_origin, credential) in &store {
            cache
                .entry(cached_origin.clone())
                .or_insert_with(|| credential.clone());
        }
    }
    if let Some(credential) = store.get(origin) {
        validate_credential(credential, origin)?;
        return Ok(Some(credential.clone()));
    }
    // Lazy migration: fold the pre-merge per-origin item into the single
    // keychain entry. The legacy item is left in place on purpose — deleting
    // it would trigger another keychain prompt, and the merged store shadows
    // it from now on.
    if let Some(credential) = read_legacy_credential_from_keyring(origin)? {
        validate_credential(&credential, origin)?;
        store.insert(origin.to_owned(), credential.clone());
        write_merged_store_to_keyring(&store)?;
        return Ok(Some(credential));
    }
    Ok(None)
}

pub(crate) async fn load_credential(base: &url::Url) -> Result<Option<StoredCredential>, String> {
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

pub(crate) fn store_credential_in_keyring(credential: &StoredCredential) -> Result<(), String> {
    validate_credential(credential, &credential.origin)?;
    let _guard = credential_store_lock()
        .lock()
        .map_err(|_| "系统凭据存储暂时不可用")?;
    let mut store = read_merged_store_from_keyring()?;
    store.insert(credential.origin.clone(), credential.clone());
    write_merged_store_to_keyring(&store)
}

pub(crate) async fn store_credential(credential: StoredCredential) -> Result<(), String> {
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

pub(crate) fn delete_credential_from_keyring(origin: &str) -> Result<(), String> {
    let _guard = credential_store_lock()
        .lock()
        .map_err(|_| "系统凭据存储暂时不可用")?;
    let mut store = read_merged_store_from_keyring()?;
    store.remove(origin);
    write_merged_store_to_keyring(&store)?;
    // The merged store shadows the legacy per-origin item; remove that one too
    // so a forget cannot resurrect through the lazy-migration fallback.
    let legacy = keyring::Entry::new(PIHUB_KEYRING_SERVICE, &credential_username(origin))
        .map_err(|_| "无法访问系统凭据存储")?;
    match legacy.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法从系统钥匙串或凭据管理器删除设备凭据".into()),
    }
}

pub(crate) async fn delete_credential(base: &url::Url) -> Result<(), String> {
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
#[derive(Deserialize)]
pub(crate) struct PairingClaimDevice {
    id: String,
    secret: String,
}

#[derive(Deserialize)]
pub(crate) struct PairingClaimResponse {
    device: PairingClaimDevice,
    authentication: AuthenticationMetadata,
}

#[tauri::command]
pub(crate) async fn pair_device(url: String, code: String) -> Result<CredentialStatus, String> {
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
    let (status, body) = match resolve_device_transport(&base) {
        DeviceTransport::Tailnet => {
            let response = send_plain(&base, &spec).await?;
            let (status, body) = response_bytes_limited(response, MAX_AUTH_RESPONSE_BYTES).await?;
            (status, body)
        }
        DeviceTransport::Relay { .. } => {
            let response =
                crate::relay::send_relay_unsigned(&base, &spec, MAX_AUTH_RESPONSE_BYTES).await?;
            let status = reqwest::StatusCode::from_u16(response.status)
                .map_err(|_| "Relay 响应状态码无效".to_owned())?;
            (status, response.body.to_vec())
        }
    };
    let local_received = local_unix_seconds()?;
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
pub(crate) async fn credential_status(url: String) -> Result<CredentialStatus, String> {
    let base = validate_tailnet_url(&url)?;
    let credential = load_credential(&base).await?;
    Ok(CredentialStatus {
        paired: credential.is_some(),
        device_id: credential.map(|item| item.device_id),
    })
}

pub(crate) fn load_relay_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(PIHUB_KEYRING_SERVICE, RELAY_TOKEN_USERNAME)
        .map_err(|_| "无法访问系统凭据存储")?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取系统凭据，请检查系统钥匙串或凭据管理器".into()),
    }
}

fn valid_relay_token(token: &str) -> bool {
    token.len() >= 32
        && token.len() <= 256
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[tauri::command]
pub(crate) fn set_relay_token(token: String) -> Result<(), String> {
    let trimmed = token.trim();
    if !valid_relay_token(trimmed) {
        return Err("Relay token 格式无效".into());
    }
    let entry = keyring::Entry::new(PIHUB_KEYRING_SERVICE, RELAY_TOKEN_USERNAME)
        .map_err(|_| "无法访问系统凭据存储")?;
    entry
        .set_password(trimmed)
        .map_err(|_| "无法将 Relay token 写入系统凭据存储".to_owned())?;
    crate::relay::invalidate_relay_client();
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RelayTokenStatus {
    configured: bool,
}

#[tauri::command]
pub(crate) fn relay_token_status() -> Result<RelayTokenStatus, String> {
    Ok(RelayTokenStatus {
        configured: load_relay_token()?.is_some(),
    })
}

#[tauri::command]
pub(crate) async fn forget_device_credential(url: String) -> Result<CredentialStatus, String> {
    let base = validate_tailnet_url(&url)?;
    delete_credential(&base).await?;
    Ok(CredentialStatus {
        paired: false,
        device_id: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::{LEGACY_DESKTOP_BUNDLE_IDENTIFIER, PIHUB_DESKTOP_BUNDLE_IDENTIFIER};

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

    fn fixture_credential(origin: &str) -> StoredCredential {
        StoredCredential {
            version: PIHUB_CREDENTIAL_VERSION,
            origin: origin.to_owned(),
            device_id: "dev_AAAAAAAAAAAAAAAAAAAAAA".into(),
            secret: format!("pihub_key_{}", "A".repeat(43)),
            epoch: "A".repeat(22),
            clock_offset_seconds: 0,
            timestamp_window_seconds: 120,
        }
    }

    #[test]
    fn merged_store_roundtrip_keeps_every_origin() {
        let mut credentials = HashMap::new();
        let first = fixture_credential("https://a.example.ts.net:30141");
        let second = fixture_credential("https://b.example.ts.net:30141");
        credentials.insert(first.origin.clone(), first.clone());
        credentials.insert(second.origin.clone(), second.clone());
        let decoded = decode_merged_store(&encode_merged_store(&credentials).unwrap()).unwrap();
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded.get(&first.origin).unwrap().secret, first.secret);
        assert_eq!(
            decoded.get(&second.origin).unwrap().device_id,
            second.device_id
        );
        assert!(
            decode_merged_store(&encode_merged_store(&HashMap::new()).unwrap())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn merged_store_rejects_unknown_version_and_malformed_json() {
        assert!(decode_merged_store("not json").is_err());
        assert!(decode_merged_store(r#"{"version":99,"credentials":{}}"#).is_err());
        assert!(decode_merged_store(r#"{"version":1}"#).is_err());
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
}

#[cfg(test)]
mod relay_token_tests {
    #[test]
    fn relay_token_validation_is_strict() {
        assert!(super::valid_relay_token(&"A".repeat(43)));
        assert!(super::valid_relay_token(&format!("{}-_", "a".repeat(40))));
        assert!(!super::valid_relay_token("short"));
        assert!(!super::valid_relay_token(&"A".repeat(300)));
        assert!(!super::valid_relay_token(&format!("{}=", "A".repeat(40))));
        assert!(!super::valid_relay_token(&format!("{} with space", "A".repeat(32))));
    }
}
