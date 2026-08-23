mod bootstrap;
mod credentials;
mod desktop_updater;
mod devices;
mod discovery;
mod files;
mod resource_cache;
mod relay;
mod session_cache;
mod setup;
mod streaming;
mod transport;
mod util;

// Filesystem-permission hardening shared with `desktop_updater`'s security module.
pub(crate) use devices::{ensure_private_directory, metadata_is_link_like, tighten_private_file};

use devices::Device;
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn open_device(app: AppHandle, device: Device) -> Result<(), String> {
    let hash = hex::encode(Sha256::digest(device.url.as_bytes()));
    let label = format!("device-{}", &hash[..12]);
    if let Some(window) = app.get_webview_window(&label) {
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let route = format!(
        "index.html?workspace={}",
        url::form_urlencoded::byte_serialize(device.id.as_bytes()).collect::<String>()
    );
    let builder = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(route.into()))
        .title(device.name.clone())
        .inner_size(1280.0, 820.0)
        .min_inner_size(780.0, 520.0);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true);
    builder
        // Keep every device as a normal native macOS window. The green traffic-light
        // button then uses macOS full screen, which automatically creates a Space.
        .decorations(true)
        .resizable(true)
        .maximizable(true)
        .fullscreen(false)
        .center()
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(desktop_updater::DesktopUpdaterState::new(env!(
            "CARGO_PKG_VERSION"
        )))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(desktop_updater::pinned_public_key())
                .build(),
        )
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            devices::list_devices,
            devices::import_legacy_device_metadata,
            devices::save_device,
            devices::remove_device,
            credentials::pair_device,
            credentials::credential_status,
            credentials::forget_device_credential,
            credentials::set_relay_token,
            credentials::relay_token_status,
            discovery::probe_device,
            discovery::discover_tailscale,
            setup::bootstrap_tailnet_peer,
            setup::check_local_server_update,
            setup::open_tailscale_approval,
            open_device,
            transport::agegr_request,
            streaming::start_agent_stream,
            streaming::stop_agent_stream,
            streaming::start_terminal_stream,
            streaming::stop_terminal_stream,
            files::export_session_html,
            files::save_text_download,
            files::download_remote_file,
            files::upload_remote_files,
            files::upload_remote_chunk,
            files::upload_remote_commit,
            files::upload_remote_abort,
            setup::bundled_versions,
            session_cache::read_session_cache,
            session_cache::write_session_cache,
            session_cache::delete_session_cache,
            session_cache::clear_session_cache,
            resource_cache::read_resource_cache,
            resource_cache::write_resource_cache,
            resource_cache::delete_resource_cache,
            resource_cache::clear_resource_cache,
            desktop_updater::desktop_update_status,
            desktop_updater::desktop_update_check,
            desktop_updater::desktop_update_install,
            desktop_updater::desktop_update_cancel,
            desktop_updater::desktop_update_restart
        ])
        .run(tauri::generate_context!())
        .expect("error while running PiHub");
}
