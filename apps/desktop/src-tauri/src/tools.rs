//! Shared external-tool and writable-location resolution (#10, #11).
//!
//! One ffmpeg resolution order for every consumer — the native audio
//! probe, the FLAC transcode, and the diagnostics/export tool probe
//! must agree or the UI reports "found" while decode fails (or the
//! reverse):
//!
//!   1. explicit override (設定 → ツール path, or the `ffmpeg_path`
//!      command argument)
//!   2. `HORNSCRIBE_FFMPEG` env var — mirrors HORNSCRIBE_ENGINE /
//!      HORNSCRIBE_PYTHON in engine.rs
//!   3. bundled `tools/ffmpeg[.exe]` under the same roots the frozen
//!      engine resolves from (resource_dir, its `resources/` child,
//!      and the executable's directory — the last also covers
//!      portable-zip layouts)
//!   4. PATH
//!
//! An explicit override that does not point at a file resolves to
//! `None` rather than falling through — silently ignoring a user-typed
//! path would make the settings badge and runtime behavior disagree.
//!
//! `data_dir` implements the portable-placement rule (#11): an
//! explicit HORNSCRIBE_DATA_DIR, or a `data/` folder beside the
//! executable, redirects ALL writable state (recordings/, sources/,
//! source-refs.json, cache/, autosave) off the OS app-data dir so a
//! portable zip stays self-contained. Installed builds never ship a
//! `data/` dir next to the exe, so their behavior is unchanged.

use std::path::{Path, PathBuf};
use tauri::Manager;

const FFMPEG_EXE: &str = if cfg!(windows) {
    "ffmpeg.exe"
} else {
    "ffmpeg"
};

/// Cheap PATH probe — `where.exe` is present on every supported Windows.
pub(crate) fn which_exists(exe: &str) -> bool {
    std::process::Command::new("where")
        .arg(exe)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Roots probed for bundled resources — the same set engine.rs resolves
/// the frozen engine from: the Tauri resource dir, its `resources/`
/// child, and the executable's own directory.
pub(crate) fn bundled_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir.clone());
        roots.push(dir.join("resources"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
        }
    }
    roots
}

/// Existing `<root>/tools/` directories — where a package ships ffmpeg
/// (and future helpers). engine.rs also prepends these to the engine
/// child's PATH so Python-side audioread resolves the same binary.
/// #190: `data_dir()/tools` leads the list — a WRITABLE drop-in root
/// for optional addons (the demucs separation bundle). Installed
/// builds put tools/ under Program Files where the user cannot write,
/// so addons live in appData (or data/ next to a portable exe); it is
/// only listed when the directory already exists.
pub(crate) fn bundled_tools_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(data) = data_dir(app) {
        let addon = data.join("tools");
        if addon.is_dir() {
            dirs.push(addon);
        }
    }
    dirs.extend(
        bundled_roots(app)
        .into_iter()
        .map(|r| r.join("tools"))
        .filter(|d| d.is_dir())
    );
    dirs
}

/// Resolve the ffmpeg executable per the module-doc order. Returns a
/// spawnable value — a bare "ffmpeg" for a PATH hit.
pub(crate) fn resolve_ffmpeg(
    app: &tauri::AppHandle,
    explicit: Option<&str>,
) -> Option<String> {
    let env_override = std::env::var("HORNSCRIBE_FFMPEG").ok();
    let explicit = explicit.map(str::trim).filter(|s| !s.is_empty());
    for candidate in [explicit.map(str::to_string), env_override]
        .into_iter()
        .flatten()
    {
        // An explicit override never falls through silently: a typo'd
        // setting must surface as "missing" so the settings badge and
        // the runtime agree, not mask itself behind another ffmpeg.
        return Path::new(&candidate).is_file().then_some(candidate);
    }
    for dir in bundled_tools_dirs(app) {
        let exe = dir.join(FFMPEG_EXE);
        if exe.is_file() {
            return Some(exe.to_string_lossy().into_owned());
        }
    }
    which_exists("ffmpeg").then(|| "ffmpeg".to_string())
}

/// Writable-state root: `HORNSCRIBE_DATA_DIR`, a `data/` dir beside the
/// executable (the portable-zip marker), else the platform app-data
/// dir (#11). All writable state hangs off this so portable installs
/// keep recordings, cache, autosave and source-refs inside the zip
/// layout instead of spilling into %APPDATA%.
pub(crate) fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("HORNSCRIBE_DATA_DIR") {
        let p = PathBuf::from(dir);
        if p.is_dir() {
            return Ok(p);
        }
        return Err(format!(
            "HORNSCRIBE_DATA_DIR is not a directory: {}",
            p.display()
        ));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let portable = dir.join("data");
            if portable.is_dir() {
                return Ok(portable);
            }
        }
    }
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))
}

/// `addons_dir`: the writable drop-in root for optional addons
/// (#190) — `data_dir()/tools`. The settings page reports this path
/// so the user knows where to extract the demucs addon zip.
#[tauri::command(async)]
pub fn addons_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?
        .join("tools")
        .to_string_lossy()
        .into_owned())
}

/// `open_addons_dir`: create if missing, open in Explorer — the same
/// UX as open_recordings_dir, pointed at the addon drop-in root.
#[tauri::command(async)]
pub fn open_addons_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = data_dir(&app)?.join("tools");
    std::fs::create_dir_all(&dir).map_err(|e| format!("tools dir: {e}"))?;
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("explorer {}: {e}", dir.display()))?;
    Ok(())
}
