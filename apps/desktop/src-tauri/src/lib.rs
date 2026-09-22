//! HornScribe desktop shell — UI-001 spike + UI-020 import plumbing.
//!
//! Security model: no fs/asset-protocol/shell/http grants. The only plugin
//! is `tauri-plugin-dialog`, capability-scoped to `dialog:allow-open` so the
//! frontend can show the native picker (no save/message variants granted).
//!
//! Because the ACL does not govern app-defined commands, the file-reading
//! commands below self-limit instead of relying on a permission grant:
//! `read_audio_bytes` serves only the advertised audio extensions with a
//! hard size cap, and `read_project_file` serves only `*.hornscribe.json`
//! project documents. Both are read-only — the source file is never
//! modified (GUI_UX_SPEC §3 / FND-001 SourceAudioRef).

use serde::Serialize;

/// Audio containers the import UX advertises (GUI_UX_SPEC §3 formats line).
/// The frontend rejects other extensions before reaching this command; the
/// allowlist here is the Rust-side backstop so the command cannot be turned
/// into a general file reader.
const AUDIO_EXTENSIONS: [&str; 5] = ["wav", "mp3", "flac", "m4a", "ogg"];

/// HornScribe project document suffix (python/hornscribe/project/model.py).
const PROJECT_FILE_SUFFIX: &str = ".hornscribe.json";

/// 512 MiB — far above any realistic horn recording (~90 MB for 10 min of
/// PCM16 stereo 44.1 kHz); guards against unbounded reads.
const MAX_AUDIO_BYTES: u64 = 512 * 1024 * 1024;
/// Project JSON is a small manifest; 16 MiB is already generous.
const MAX_PROJECT_BYTES: u64 = 16 * 1024 * 1024;

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
        rust_target_env: (if cfg!(target_env = "msvc") {
            "msvc"
        } else if cfg!(target_env = "gnu") {
            "gnu"
        } else {
            "other"
        })
        .to_string(),
    }
}

/// Read a user-selected audio file and return its bytes over raw IPC so the
/// webview can decode it (WebAudio `decodeAudioData`) and hash it
/// (WebCrypto SHA-256, mirroring `hash_file_sha256` in the project schema).
/// Read-only, extension-allowlisted, size-capped.
#[tauri::command]
fn read_audio_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !AUDIO_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("unsupported audio extension: {ext}"));
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {path}"));
    }
    if meta.len() > MAX_AUDIO_BYTES {
        return Err(format!("audio file too large: {} bytes", meta.len()));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Read a `*.hornscribe.json` project document (schema v1, FND-001) so the
/// import flow can recover sourceAudio.originalPath/contentHash for the
/// relink UX. Read-only, suffix-restricted, size-capped.
#[tauri::command]
fn read_project_file(path: String) -> Result<tauri::ipc::Response, String> {
    if !path.to_ascii_lowercase().ends_with(PROJECT_FILE_SUFFIX) {
        return Err(format!("not a HornScribe project file: {path}"));
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {path}"));
    }
    if meta.len() > MAX_PROJECT_BYTES {
        return Err(format!("project file too large: {} bytes", meta.len()));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            shell_info,
            read_audio_bytes,
            read_project_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running HornScribe shell");
}
