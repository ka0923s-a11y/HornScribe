//! Diagnostics commands (GUI_UX_SPEC §19, UI-060 / #403): the cache/log
//! paths the 診断情報 sheet displays and the ログフォルダを開く action.
//! engine.rs tees worker stderr into logs/engine-<unix>.log per spawn
//! so the folder this reveals actually contains engine diagnostics.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsPaths {
    cache: String,
    logs: String,
}

fn app_dir(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    // #11: portable installs report paths under <exe>/data/.
    let dir = crate::tools::data_dir(app)?.join(name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// <app_data>/logs — created on demand so reveal_log_folder always
/// has a real directory to open. Shared with engine.rs's stderr tee.
pub(crate) fn log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_dir(app, "logs")
}

/// <app_data>/cache — transcription artifacts live here. Created so
/// the reported path is real, mirroring log_dir.
fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_dir(app, "cache")
}

/// diagnostics_paths: the §19 cache/log locations. Both directories are
/// created so the sheet never reports a path that does not exist yet.
#[tauri::command]
pub fn diagnostics_paths(app: tauri::AppHandle) -> Result<DiagnosticsPaths, String> {
    Ok(DiagnosticsPaths {
        cache: cache_dir(&app)?.to_string_lossy().into_owned(),
        logs: log_dir(&app)?.to_string_lossy().into_owned(),
    })
}

/// reveal_log_folder: ログフォルダを開く — reuses the export module's
/// explorer reveal, which requires an existing directory (log_dir just
/// created it).
#[tauri::command]
pub fn reveal_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = log_dir(&app)?;
    crate::export::reveal_in_explorer(dir.to_string_lossy().into_owned())
}

/// Per-spawn engine stderr log (engine-<unix>.log), retention-pruned.
/// Returns a buffered writer or None when the log dir is unavailable —
/// logging must never block the engine spawn itself.
pub(crate) fn engine_log_file(
    app: &tauri::AppHandle,
) -> Option<std::io::BufWriter<std::fs::File>> {
    let dir = log_dir(app).ok()?;
    prune_engine_logs(&dir);
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    std::fs::File::create(dir.join(format!("engine-{secs}.log")))
        .ok()
        .map(std::io::BufWriter::new)
}

/// Retention: keep the newest engine-*.log files so a crash-looping
/// engine cannot fill the disk. Lexicographic oldest-first order works
/// because the unix-second stem stays fixed-width this century.
fn prune_engine_logs(dir: &Path) {
    const MAX_ENGINE_LOGS: usize = 10;
    let mut logs: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && p
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with("engine-") && n.ends_with(".log"))
                        .unwrap_or(false)
            })
            .collect(),
        Err(_) => return,
    };
    // The caller is about to add one more file.
    if logs.len() < MAX_ENGINE_LOGS {
        return;
    }
    let excess = logs.len() + 1 - MAX_ENGINE_LOGS;
    logs.sort();
    for p in logs.into_iter().take(excess) {
        let _ = std::fs::remove_file(p);
    }
}
