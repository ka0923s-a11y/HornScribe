//! HornScribe desktop shell — UI-001 spike.
//!
//! Intentionally minimal: one `shell_info` command proves the JS↔Rust IPC
//! channel works inside the restrictive CSP/capability baseline. No plugins
//! are registered — the frontend holds no fs/dialog/asset-protocol grants.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellInfo {
    app_name: String,
    version: String,
    rust_target_env: String,
}

#[tauri::command]
fn shell_info(app: tauri::AppHandle) -> ShellInfo {
    let pkg = app.package_info();
    ShellInfo {
        app_name: pkg.name.clone(),
        version: pkg.version.to_string(),
        rust_target_env: if cfg!(target_env = "msvc") {
            "msvc"
        } else if cfg!(target_env = "gnu") {
            "gnu"
        } else {
            "other"
        }
        .to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![shell_info])
        .run(tauri::generate_context!())
        .expect("error while running HornScribe shell");
}
