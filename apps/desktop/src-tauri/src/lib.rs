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

mod audio;
mod capture;
mod diagnostics;
mod engine;
mod export;
mod tools;

/// Audio containers the import UX advertises (GUI_UX_SPEC §3 formats line).
/// The frontend rejects other extensions before reaching this command; the
/// allowlist here is the Rust-side backstop so the command cannot be turned
/// into a general file reader.
const AUDIO_EXTENSIONS: [&str; 5] = ["wav", "mp3", "flac", "m4a", "ogg"];

/// HornScribe project document suffix (python/hornscribe/project/model.py).
// #389: shared with export.rs's project_write (the shell-side save).
pub(crate) const PROJECT_FILE_SUFFIX: &str = ".hornscribe.json";

/// 512 MiB — far above any realistic horn recording (~90 MB for 10 min of
/// PCM16 stereo 44.1 kHz); guards against unbounded reads.
const MAX_AUDIO_BYTES: u64 = 512 * 1024 * 1024;
/// Project JSON embeds the canonical score + both MusicXML bodies
/// (#218), so long pieces legitimately exceed the old 16 MiB cap —
/// the save side has no limit and the open side must not reject
/// projects it wrote (#262). 128 MiB is far above any realistic
/// score while still guarding against unbounded reads.
const MAX_PROJECT_BYTES: u64 = 128 * 1024 * 1024;

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
#[tauri::command(async)]
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
#[tauri::command(async)]
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

/// Confirmed-exit fallback (#407): the close guards resolve to
/// `window.destroy()`, which is ACL-gated (`core:window:allow-destroy`).
/// If that grant ever regresses the frontend falls back to this app-owned
/// command — the ACL only gates plugin commands, so an app can always
/// exit itself. `app.exit` still runs the RunEvent::Exit cleanup that
/// kills the engine sidecar.
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/* ------------------------- close watchdog (#192) --------------------------
 *
 * Tauri calls prevent_close() internally whenever a JS listener for
 * tauri://close-requested exists (manager/window.rs) — after our
 * onCloseRequested registers, the window can ONLY die through the JS
 * handler calling destroy()/exit_app. Two ways that never happens:
 *
 *   1. the WebView2 renderer is hung or dead — the close-requested event
 *      is emitted but no JS ever runs;
 *   2. the Rust main thread is blocked — destroy()/exit_app are IPC and
 *      can no longer be dispatched (the async-conversion of the blocking
 *      commands in this release removes today's sources of this).
 *
 * The watchdog makes "X does nothing" impossible: each CloseRequested
 * bumps CLOSE_GEN and arms a timer. A healthy JS handler fires
 * close_request_ack within milliseconds (it is the first thing it does,
 * before any guard dialog opens — a user thinking in the dialog is safe
 * because the ack already landed). No ack within CLOSE_ACK_TIMEOUT means
 * the renderer could not even process the event: we destroy the window
 * from Rust (a hung webview cannot veto a Rust-issued destroy), and if
 * the event loop itself is wedged and destroy cannot land, the process
 * is exited directly — the engine sidecar dies with us via its Job
 * Object (#185) and a dirty score is covered by the autosave snapshot
 * (#221), so a forced exit loses at most a few seconds of edits.
 */
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static CLOSE_GEN: AtomicU64 = AtomicU64::new(0);
static CLOSE_ACKED: AtomicU64 = AtomicU64::new(0);

/// How long the JS close handler may stay silent before Rust destroys
/// the window itself. A healthy handler acks in <50 ms; 10 s is far
/// beyond any transient jank yet short enough to feel like "the app
/// closed when I asked it to" to a user staring at a hung window.
const CLOSE_ACK_TIMEOUT: Duration = Duration::from_secs(10);
/// After a Rust-issued destroy() the event loop should die almost
/// immediately; if it is itself wedged the destroy can never land —
/// this is the final guaranteed exit (engine tree still dies via the
/// Job Object's KILL_ON_JOB_CLOSE).
const CLOSE_HARD_EXIT_DELAY: Duration = Duration::from_secs(5);

/// Frontend "I saw the close request" heartbeat — proves the renderer's
/// event loop is alive. Deliberately trivial: it must run even while
/// the app is mid-dialog or mid-job, so it touches nothing but an
/// atomic. Sync command (main thread): if the main thread itself is
/// wedged the ack simply never lands and the watchdog correctly takes
/// over.
#[tauri::command]
fn close_request_ack() {
    CLOSE_ACKED.store(CLOSE_GEN.load(Ordering::SeqCst), Ordering::SeqCst);
}

fn arm_close_watchdog(window: &tauri::Window) {
    let gen = CLOSE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let window = window.clone();
    std::thread::Builder::new()
        .name("hornscribe-close-watchdog".into())
        .spawn(move || {
            std::thread::sleep(CLOSE_ACK_TIMEOUT);
            // Acked => the JS handler is alive and owns the close
            // (guard dialog / confirmed destroy). Nothing to do.
            if CLOSE_ACKED.load(Ordering::SeqCst) >= gen {
                return;
            }
            // Renderer never answered — force the window down. If the
            // main thread is alive this lands and the process exits
            // through the normal RunEvent::Exit cleanup.
            let _ = window.destroy();
            std::thread::sleep(CLOSE_HARD_EXIT_DELAY);
            // Still here => the event loop could not process the
            // destroy either. Guaranteed exit; the engine tree is
            // collected by its Job Object and dirty work by autosave.
            if CLOSE_ACKED.load(Ordering::SeqCst) < gen {
                std::process::exit(0);
            }
        })
        .expect("spawn close watchdog");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // #230: media custom scheme — token-scoped audio streaming for
        // <audio> playback (Range-capable; only paths registered by
        // audio_probe resolve).
        .register_asynchronous_uri_scheme_protocol(
            "media",
            audio::media_scheme_handler,
        )
        .invoke_handler(tauri::generate_handler![
            shell_info,
            read_audio_bytes,
            read_project_file,
            exit_app,
            close_request_ack,
            audio::audio_probe,
            capture::capture_start,
            capture::capture_stop,
            capture::capture_cancel,
            capture::capture_status,
            capture::capture_devices,
            capture::capture_audio_sessions,
            capture::capture_pause,
            capture::capture_resume,
            capture::recordings_info,
            capture::open_recordings_dir,
            capture::clear_recordings,
            capture::recordings_list,
            capture::delete_recording,
            capture::copy_recording_to_managed,
            capture::sources_info,
            capture::sources_list,
            capture::open_sources_dir,
            capture::delete_source,
            capture::source_refs_update,
            capture::source_refs_index,
            engine::engine_spawn,
            engine::engine_write,
            engine::engine_close_stdin,
            engine::engine_kill,
            diagnostics::diagnostics_paths,
            diagnostics::reveal_log_folder,
            export::export_pick_dir,
            export::export_default_dir,
            export::export_check_existing,
            export::export_run,
            export::export_cancel,
            export::detect_tools,
            export::probe_tool_path,
            export::reveal_in_explorer,
            export::project_save_path,
            export::project_write,
            export::project_autosave_write,
            export::project_autosave_status,
            export::project_autosave_clear,
            export::open_in_musescore,
        ])
        // #192: arm the no-JS-response watchdog on every OS close
        // request — the JS listener may be alive (it acks and the
        // timer disarms) or hung (the timer forces the window down).
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                arm_close_watchdog(window);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building HornScribe shell")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                engine::kill_engine_on_exit();
            }
        });
}
