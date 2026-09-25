//! #99: export commands — destination picker, artifact file writes,
//! tool detection, explorer reveal and MuseScore PDF rendering.
//!
//! Self-limiting model (same posture as lib.rs's read commands): the
//! frontend cannot write anywhere it likes. A destination directory is
//! writable only when it
//!   - was picked through `export_pick_dir` this session, or
//!   - lives under the OS Documents directory.
//! File names are restricted to the export artifact extensions
//! (.musicxml/.xml/.mid/.pdf) and may not contain path separators, so
//! the command can never escape the destination directory.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::PROJECT_FILE_SUFFIX;

/// Artifact extensions the export flow may write (§17 formats).
const EXPORT_EXTENSIONS: [&str; 4] = ["musicxml", "xml", "mid", "pdf"];

/// Audio extensions the sourceAudio bundle may copy (#87).
const AUDIO_EXTENSIONS: [&str; 5] = ["wav", "mp3", "flac", "m4a", "ogg"];

/// Directories the user explicitly picked via `export_pick_dir` this
/// session — the write side of the self-limiting model.
static GRANTED_DIRS: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

/// A live `export_run` — the cancel flag flips from `export_cancel`,
/// and the in-flight MuseScore child is killed on cancel (#383).
struct ExportHandle {
    cancelled: AtomicBool,
    child: Mutex<Option<std::process::Child>>,
}

/// exportId -> live export. Entries are removed when `export_run`
/// returns; a cancel for an unknown/finished id is a no-op.
static EXPORT_RUNS: Mutex<Option<HashMap<String, Arc<ExportHandle>>>> =
    Mutex::new(None);

fn export_runs() -> std::sync::MutexGuard<'static, Option<HashMap<String, Arc<ExportHandle>>>> {
    EXPORT_RUNS.lock().unwrap_or_else(|e| e.into_inner())
}

fn export_cancelled(handle: Option<&ExportHandle>) -> bool {
    handle.is_some_and(|h| h.cancelled.load(Ordering::SeqCst))
}

/// `export_cancel` — flip the flag and kill the MuseScore child if one
/// is in flight. The run itself notices at its next checkpoint and
/// tears the staging dir down without committing anything (#383).
#[tauri::command]
pub fn export_cancel(export_id: String) -> Result<(), String> {
    let handle = {
        let guard = export_runs();
        guard.as_ref().and_then(|m| m.get(&export_id).cloned())
    };
    if let Some(h) = handle {
        h.cancelled.store(true, Ordering::SeqCst);
        if let Some(mut child) = h.child.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}

fn grant_dir(dir: PathBuf) {
    let mut guard = GRANTED_DIRS.lock().unwrap_or_else(|e| e.into_inner());
    guard.get_or_insert_with(HashSet::new).insert(dir);
}

/// One artifact to write: file name + base64 payload (NDJSON-safe).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    pub name: String,
    pub data_base64: String,
}

/// `export_pick_dir`: native folder picker (Rust-side dialog plugin — no
/// JS plugin permission needed). A picked directory is granted write
/// access for the rest of the session; returns null on cancel.
#[tauri::command]
pub fn export_pick_dir(
    app: tauri::AppHandle,
    current: Option<String>,
) -> Result<Option<String>, String> {
    let mut dlg = app.dialog().file();
    if let Some(dir) = current {
        let p = PathBuf::from(&dir);
        if p.is_dir() {
            dlg = dlg.set_directory(p);
        }
    }
    let Some(path) = dlg.blocking_pick_folder() else {
        return Ok(None);
    };
    let dir = path
        .as_path()
        .map(|p| p.to_path_buf())
        .ok_or("picked path is not a filesystem path")?;
    grant_dir(dir.clone());
    Ok(Some(dir.to_string_lossy().into_owned()))
}

/// `export_default_dir`: `<Documents>/HornScribe` (reported without
/// creating — the dialog shows the path before anything is written).
#[tauri::command]
pub fn export_default_dir(app: tauri::AppHandle) -> Result<String, String> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("document dir: {e}"))?;
    let dir = docs.join("HornScribe");
    Ok(dir.to_string_lossy().into_owned())
}

/// Whether `dir` is a legal export destination: picked this session or
/// under the OS Documents directory.
fn dir_allowed(app: &tauri::AppHandle, dir: &Path) -> bool {
    if let Ok(guard) = GRANTED_DIRS.lock() {
        if let Some(set) = guard.as_ref() {
            if set.contains(dir) {
                return true;
            }
        }
    }
    if let Ok(docs) = app.path().document_dir() {
        if dir.starts_with(&docs) {
            return true;
        }
    }
    false
}

/// Validate one artifact file name: no separators, allowlisted
/// extension, non-empty stem.
fn valid_export_name(name: &str) -> bool {
    let path = Path::new(name);
    if path.file_name().and_then(|n| n.to_str()) != Some(name) {
        return false;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    EXPORT_EXTENSIONS.contains(&ext.as_str())
        && path
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| !s.is_empty())
}

/// Like `valid_export_name` but for the audio bundle name — the
/// `<stem>_source.<ext>` copy keeps the source's own extension, which
/// is an audio type, not a score artifact type (#87).
fn valid_audio_name(name: &str) -> bool {
    let path = Path::new(name);
    if path.file_name().and_then(|n| n.to_str()) != Some(name) {
        return false;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    AUDIO_EXTENSIONS.contains(&ext.as_str())
        && path
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| !s.is_empty())
}

/// Any name the collision check may be asked about — score artifact
/// or audio bundle copy.
fn valid_artifact_name(name: &str) -> bool {
    valid_export_name(name) || valid_audio_name(name)
}

/// `detect_tools`: probe MuseScore/ffmpeg for the export + diagnostics
/// surfaces. PATH first, then the standard MuseScore install dirs.
#[tauri::command]
pub fn detect_tools() -> DetectedTools {
    DetectedTools {
        muse_score: probe_tool(
            &["MuseScore4", "MuseScore3", "musescore"],
            &[
                r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe",
                r"C:\Program Files\MuseScore 3\bin\MuseScore3.exe",
                r"C:\Program Files (x86)\MuseScore 4\bin\MuseScore4.exe",
            ],
        ),
        ffmpeg: probe_tool(&["ffmpeg"], &[]),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedTools {
    pub muse_score: ToolProbe,
    pub ffmpeg: ToolProbe,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProbe {
    pub status: String, // "found" | "missing"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

fn probe_tool(path_names: &[&str], absolute_candidates: &[&str]) -> ToolProbe {
    for name in path_names {
        if which_exists(name) {
            return ToolProbe {
                status: "found".into(),
                path: Some((*name).to_string()),
            };
        }
    }
    for candidate in absolute_candidates {
        if Path::new(candidate).is_file() {
            return ToolProbe {
                status: "found".into(),
                path: Some((*candidate).to_string()),
            };
        }
    }
    ToolProbe {
        status: "missing".into(),
        path: None,
    }
}

fn which_exists(exe: &str) -> bool {
    std::process::Command::new("where")
        .arg(exe)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// `probe_tool_path`: verify a user-specified tool path (設定 → ツール)
/// actually points at a file. The settings/diagnostics surfaces used to
/// mark any non-empty override "found" until the export subprocess
/// failed — this lets them probe the real path up front (#363).
#[tauri::command]
pub fn probe_tool_path(path: String) -> ToolProbe {
    let trimmed = path.trim();
    if !trimmed.is_empty() && Path::new(trimmed).is_file() {
        ToolProbe {
            status: "found".into(),
            path: Some(trimmed.to_string()),
        }
    } else {
        ToolProbe {
            status: "missing".into(),
            path: None,
        }
    }
}

/// `reveal_in_explorer`: open a directory in the OS file manager.
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("EXPORT_DESTINATION_INVALID: not a directory: {path}"));
    }
    std::process::Command::new("explorer")
        .arg(&p)
        .spawn()
        .map_err(|e| format!("explorer {}: {e}", p.display()))?;
    Ok(())
}

/// `project_save_path`: native save-file picker for `.hornscribe.json`
/// (#100). The picked file's parent directory is granted write access
/// (same model as `export_pick_dir`); returns null on cancel.
#[tauri::command]
pub fn project_save_path(
    app: tauri::AppHandle,
    suggested_name: Option<String>,
) -> Result<Option<String>, String> {
    let mut dlg = app
        .dialog()
        .file()
        .add_filter("HornScribe プロジェクト", &["hornscribe.json"]);
    if let Some(name) = suggested_name {
        if !name.is_empty() {
            dlg = dlg.set_file_name(&name);
        }
    }
    let Some(path) = dlg.blocking_save_file() else {
        return Ok(None);
    };
    let file = path
        .as_path()
        .map(|p| p.to_path_buf())
        .ok_or("picked path is not a filesystem path")?;
    if let Some(parent) = file.parent() {
        grant_dir(parent.to_path_buf());
    }
    // The dialog may return the name without the suffix the filter
    // describes — append it so the worker's path check never trips
    // on a user-typed name.
    let file = if file.to_string_lossy().ends_with(".hornscribe.json") {
        file
    } else {
        let mut name = file
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        // "take.json" → "take"; "take.hornscribe" → "take"
        for suffix in [".hornscribe.json", ".hornscribe", ".json"] {
            if let Some(stripped) = name.strip_suffix(suffix) {
                name = stripped.to_string();
                break;
            }
        }
        file.with_file_name(format!("{name}.hornscribe.json"))
    };
    Ok(Some(file.to_string_lossy().into_owned()))
}

/* --------------------- autosave / crash recovery (#221) ---------------------
 *
 * appDataDir/autosave.hornscribe.json — a debounced copy of the project
 * document the UI builds on every dirty edit. On launch the frontend
 * asks for its metadata; a recovery file newer than the last clean
 * save means a crash left unsaved work behind and the app offers to
 * restore it. The file is content-addressed by the project schema
 * itself (schemaVersion 1), so restore is just an open.
 *
 * A sibling .meta.json records the path the autosave was taken
 * against, so a restore of an already-saved project keeps saving to
 * the original file instead of the recovery location. */

fn autosave_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("autosave.hornscribe.json"))
}

fn autosave_meta_path(data_path: &Path) -> PathBuf {
    data_path.with_file_name("autosave.hornscribe.meta.json")
}

/// project_autosave_write: persist the recovery snapshot. The content
/// is the same schema-v1 JSON the normal save path produces — written
/// via tmp+rename so a crash mid-write never leaves a torn file.
#[tauri::command]
pub fn project_autosave_write(
    app: tauri::AppHandle,
    contents: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let path = autosave_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("autosave dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &contents)
        .map_err(|e| format!("write autosave: {e}"))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("rename autosave: {e}"))?;
    // Sidecar metadata — best-effort: a missing meta only means the
    // restore cannot re-point at the original file, never a lost score.
    let meta = serde_json::json!({ "projectPath": project_path });
    let meta_tmp = autosave_meta_path(&path).with_extension("tmp");
    if std::fs::write(&meta_tmp, meta.to_string()).is_ok() {
        let _ = std::fs::rename(&meta_tmp, autosave_meta_path(&path));
    }
    Ok(())
}

/// project_autosave_status: recovery-file metadata for the launch
/// check — null when no autosave exists.
#[tauri::command]
pub fn project_autosave_status(
    app: tauri::AppHandle,
) -> Result<Option<AutosaveInfo>, String> {
    let path = autosave_path(&app)?;
    let meta = match std::fs::metadata(&path) {
        Ok(m) if m.is_file() => m,
        _ => return Ok(None),
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // The saved-against path rides in the sidecar; an unreadable or
    // absent meta degrades to "restore as an unsaved project".
    let project_path = std::fs::read_to_string(autosave_meta_path(&path))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("projectPath")
                .and_then(|p| p.as_str())
                .map(str::to_owned)
        });
    Ok(Some(AutosaveInfo {
        path: path.to_string_lossy().into_owned(),
        modified_sec: modified,
        size_bytes: meta.len(),
        project_path,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutosaveInfo {
    /// Absolute path — the frontend re-reads it via read_project_file.
    pub path: String,
    /// Last write (UNIX seconds) — shown in the restore prompt.
    pub modified_sec: u64,
    pub size_bytes: u64,
    /// Path the autosave was taken against (null = never saved).
    pub project_path: Option<String>,
}


/// project_autosave_clear: drop the recovery file — called after a
/// successful explicit save or when the user declines the restore.
#[tauri::command]
pub fn project_autosave_clear(app: tauri::AppHandle) -> Result<(), String> {
    let path = autosave_path(&app)?;
    for p in [path.clone(), autosave_meta_path(&path)] {
        match std::fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("clear autosave: {e}")),
        }
    }
    Ok(())
}

/* ------------------------- manual project save (#389) ----------------------
 *
 * `project_write` is the engine-free counterpart of the worker's
 * `project.save`: the schema-v1 document arrives already serialized
 * (the frontend validator mirrors HornScribeProject.from_dict, and the
 * JSON parse below fails closed before anything touches disk), and the
 * write protocol mirrors ProjectStore — same-directory `.tmp` file,
 * fsync, the previous good file kept as a sibling `.recovery`, then the
 * atomic rename.
 *
 * Self-limiting: a fresh save must land in a dir the export model
 * already allows (picked via `project_save_path`, or under Documents);
 * re-saving an existing project file is allowed wherever it lives —
 * the file's presence proves the user pointed at it.
 */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWriteResult {
    pub path: String,
    pub project_id: String,
}

/// `project_write`: persist a `.hornscribe.json` document without the
/// Python worker (#389) so Ctrl+S still lands when the engine is down.
#[tauri::command]
pub fn project_write(
    app: tauri::AppHandle,
    path: String,
    contents: String,
) -> Result<ProjectWriteResult, String> {
    let target = PathBuf::from(&path);
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !name.ends_with(PROJECT_FILE_SUFFIX) {
        return Err(format!(
            "project_write requires a {PROJECT_FILE_SUFFIX} path"
        ));
    }
    // Fail closed on malformed content before any filesystem touch —
    // the schema check lives in the frontend validator; this only
    // proves the payload is JSON carrying a projectId.
    let doc: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("project contents is not JSON: {e}"))?;
    let project_id = doc
        .get("projectId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if project_id.is_empty() {
        return Err("project document carries no projectId".into());
    }
    let parent = target
        .parent()
        .ok_or("project path has no parent directory")?;
    if !target.exists() && !dir_allowed(&app, parent) {
        return Err(format!(
            "directory not writable for projects: {}",
            parent.display()
        ));
    }
    write_project_file(&target, &contents)?;
    Ok(ProjectWriteResult {
        path: target.to_string_lossy().into_owned(),
        project_id,
    })
}

/// The write half of `project_write`, split out so the protocol is
/// unit-testable without an AppHandle. Mirrors
/// `ProjectStore._atomic_write_json`: same-directory `.tmp` write +
/// fsync, the previous good file becomes `<name>.recovery`, then the
/// atomic rename (std::fs::rename replaces on Windows too).
fn write_project_file(target: &Path, contents: &str) -> Result<(), String> {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("project dir {}: {e}", parent.display()))?;
    }
    let tmp = target.with_file_name(format!("{name}.tmp"));
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("fsync {}: {e}", tmp.display()))?;
    }
    if target.exists() {
        let recovery = target.with_file_name(format!("{name}.recovery"));
        std::fs::rename(&target, &recovery).map_err(|e| {
            format!("recovery snapshot {}: {e}", recovery.display())
        })?;
    }
    std::fs::rename(&tmp, &target)
        .map_err(|e| format!("rename {}: {e}", target.display()))
}

/// Which of the requested artifact names already exist in `dir` —
/// the collision check the dialog runs before writing so an export
/// never silently destroys a previous result (#231). Returns the
/// clashing *names* (not paths); an empty list means the set is clear.
#[tauri::command]
pub fn export_check_existing(
    app: tauri::AppHandle,
    dir: String,
    names: Vec<String>,
) -> Result<Vec<String>, String> {
    let dir_path = PathBuf::from(&dir);
    if !dir_allowed(&app, &dir_path) {
        return Err("PERMISSION_DENIED".to_string());
    }
    let mut existing = Vec::new();
    for name in names {
        if !valid_artifact_name(&name) {
            return Err(format!("EXPORT_NAME_INVALID: {}", name));
        }
        if dir_path.join(&name).is_file() {
            existing.push(name);
        }
    }
    Ok(existing)
}

/// One source-audio copy for `export_run` (#87): the final artifact
/// name plus the absolute path of the audio file to copy.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAudioCopy {
    pub name: String,
    pub src: String,
}

/// One PDF artifact for `export_run`: the final .pdf name plus the
/// MusicXML source rendered through MuseScore.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRunPdf {
    pub name: String,
    pub music_xml: String,
}

/// #384: every export error carries a stable `CODE:` prefix — the TS
/// `mapInvokeError` reads the prefix to pick the right recovery
/// surface; the rest of the message (context, path, OS error) stays
/// for diagnostics and never reaches the dialog. `fallback` is the
/// code used when the OS error isn't a known actionable cause.
fn io_export_error(
    context: &str,
    path: &Path,
    e: &std::io::Error,
    fallback: &str,
) -> String {
    let code = match e.kind() {
        std::io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
        _ => match e.raw_os_error() {
            // ENOSPC / ERROR_HANDLE_DISK_FULL / ERROR_DISK_FULL / EDQUOT.
            Some(28) | Some(39) | Some(112) | Some(122) => "EXPORT_DISK_FULL",
            // EPERM / EACCES / ERROR_ACCESS_DENIED / ERROR_WRITE_PROTECT / EROFS.
            Some(1) | Some(13) | Some(5) | Some(19) | Some(30) => "PERMISSION_DENIED",
            _ => fallback,
        },
    };
    format!("{code}: {context} {}: {e}", path.display())
}

/// `export_run` — the transactional export (#258). Every artifact is
/// produced into a private staging directory first; only when audio,
/// batch files AND all PDF renders succeed does the command move them
/// into the destination. A failure anywhere cleans the staging dir and
/// leaves the destination untouched — no half-written artifact sets.
///
/// Collision policy (#231) is decided by the frontend before this call
/// (export_check_existing + the dialog's overwrite/rename/cancel), so a
/// commit here overwrites intentionally.
#[tauri::command]
pub fn export_run(
    app: tauri::AppHandle,
    dir: String,
    audio: Option<ExportAudioCopy>,
    files: Vec<ExportFile>,
    pdfs: Vec<ExportRunPdf>,
    musescore_path: Option<String>,
    export_id: String,
) -> Result<Vec<String>, String> {
    let dir_path = PathBuf::from(&dir);
    if !dir_allowed(&app, &dir_path) {
        return Err("PERMISSION_DENIED".to_string());
    }
    // #383: register before any work so a cancel arriving early still
    // lands — the run checkpoints between every stage.
    let handle = Arc::new(ExportHandle {
        cancelled: AtomicBool::new(false),
        child: Mutex::new(None),
    });
    {
        let mut guard = export_runs();
        guard
            .get_or_insert_with(HashMap::new)
            .insert(export_id.clone(), handle.clone());
    }
    let result = run_export(
        &dir_path,
        audio,
        files,
        pdfs,
        musescore_path,
        Some(&handle),
    );
    {
        let mut guard = export_runs();
        if let Some(m) = guard.as_mut() {
            m.remove(&export_id);
        }
    }
    result
}

/// The transactional body of `export_run`, split from the AppHandle
/// wrapper so the stage→commit flow is unit-testable (#258).
fn run_export(
    dir_path: &Path,
    audio: Option<ExportAudioCopy>,
    files: Vec<ExportFile>,
    pdfs: Vec<ExportRunPdf>,
    musescore_path: Option<String>,
    handle: Option<&ExportHandle>,
) -> Result<Vec<String>, String> {
    // #383: cancel checkpoints — the flag is cheap to read, so every
    // stage boundary honours a cancel; once the commit loop starts it
    // runs to completion (a half-committed set is worse than a
    // finished one), so the last gate sits right before it.
    let check = |h: Option<&ExportHandle>| -> Result<(), String> {
        if export_cancelled(h) {
            return Err("EXPORT_CANCELLED".to_string());
        }
        Ok(())
    };
    // Validate everything before touching the filesystem — a bad name
    // must not leave a half-staged directory behind.
    for f in &files {
        if !valid_export_name(&f.name) {
            return Err(format!("EXPORT_NAME_INVALID: {}", f.name));
        }
    }
    for p in &pdfs {
        if !valid_export_name(&p.name) || !p.name.to_ascii_lowercase().ends_with(".pdf") {
            return Err(format!("EXPORT_NAME_INVALID: {}", p.name));
        }
    }
    if let Some(a) = &audio {
        if !valid_audio_name(&a.name) {
            return Err(format!("EXPORT_NAME_INVALID: {}", a.name));
        }
        if !PathBuf::from(&a.src).is_file() {
            return Err(format!("EXPORT_SOURCE_MISSING: {}", a.src));
        }
    }
    let exe = if pdfs.is_empty() {
        None
    } else {
        let path = musescore_path.ok_or("MUSESCORE_UNAVAILABLE")?;
        let exe = PathBuf::from(&path);
        if !exe.is_file() {
            return Err("MUSESCORE_UNAVAILABLE".to_string());
        }
        Some(exe)
    };
    std::fs::create_dir_all(dir_path).map_err(|e| {
        io_export_error("create", dir_path, &e, "EXPORT_DESTINATION_INVALID")
    })?;

    let uniq = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let staging =
        std::env::temp_dir().join(format!("hornscribe-export-{}-{}", std::process::id(), uniq));
    let result = (|| -> Result<Vec<String>, String> {
        check(handle)?;
        std::fs::create_dir_all(&staging)
            .map_err(|e| io_export_error("stage", &staging, &e, "EXPORT_WRITE_FAILED"))?;
        let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
        if let Some(a) = &audio {
            check(handle)?;
            let src = PathBuf::from(&a.src);
            let tmp = staging.join(&a.name);
            std::fs::copy(&src, &tmp).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    // The source existed at validation but vanished mid-run.
                    format!("EXPORT_SOURCE_MISSING: {}", a.src)
                } else {
                    io_export_error("copy", &tmp, &e, "EXPORT_WRITE_FAILED")
                }
            })?;
            staged.push((tmp, dir_path.join(&a.name)));
        }
        for f in &files {
            check(handle)?;
            let bytes = decode_base64(&f.data_base64)
                .map_err(|e| format!("EXPORT_INTERNAL: {}: {e}", f.name))?;
            let tmp = staging.join(&f.name);
            std::fs::write(&tmp, &bytes)
                .map_err(|e| io_export_error("write", &tmp, &e, "EXPORT_WRITE_FAILED"))?;
            staged.push((tmp, dir_path.join(&f.name)));
        }
        if let Some(exe) = &exe {
            for p in &pdfs {
                check(handle)?;
                let tmp_xml = staging.join(format!("{}.musicxml", p.name));
                std::fs::write(&tmp_xml, p.music_xml.as_bytes())
                    .map_err(|e| io_export_error("stage", &tmp_xml, &e, "EXPORT_WRITE_FAILED"))?;
                let tmp_pdf = staging.join(&p.name);
                // #383: spawn + poll instead of blocking .status() —
                // export_cancel flips the flag AND kills the child,
                // and the poll loop notices either way.
                let status = wait_render(exe, &tmp_pdf, &tmp_xml, handle);
                let _ = std::fs::remove_file(&tmp_xml);
                match status {
                    Ok(s) if s.success() && tmp_pdf.is_file() => {}
                    Ok(s) => {
                        return Err(format!(
                            "EXPORT_MUSESCORE_RENDER_FAILED: MuseScore exited with {s}"
                        ));
                    }
                    Err(e) => {
                        return Err(e);
                    }
                }
                staged.push((tmp_pdf, dir_path.join(&p.name)));
            }
        }
        // Last cancel gate: once the commit loop starts it runs to
        // completion — a half-committed artifact set is worse than a
        // finished one the user can simply delete.
        check(handle)?;
        let mut out = Vec::with_capacity(staged.len());
        for (tmp, dest) in staged {
            if dest.exists() {
                let _ = std::fs::remove_file(&dest);
            }
            match std::fs::rename(&tmp, &dest) {
                Ok(()) => {}
                Err(_) => {
                    std::fs::copy(&tmp, &dest)
                        .map_err(|e| {
                            // #384: a commit-phase failure can leave a
                            // partial artifact set — a distinct code
                            // keeps the dialog honest about that.
                            format!("EXPORT_COMMIT_FAILED: write {}: {e}", dest.display())
                        })?;
                    let _ = std::fs::remove_file(&tmp);
                }
            }
            out.push(dest.to_string_lossy().into_owned());
        }
        Ok(out)
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Spawn one MuseScore PDF render and wait for it — killable (#383).
/// With a live export handle the child parks in the handle's slot so
/// `export_cancel` can take+kill it while the poll loop also watches
/// the flag; without a handle (unit tests) it waits inline, the same
/// semantics the old blocking `.status()` had.
fn wait_render(
    exe: &Path,
    tmp_pdf: &Path,
    tmp_xml: &Path,
    handle: Option<&ExportHandle>,
) -> Result<std::process::ExitStatus, String> {
    let spawned = std::process::Command::new(exe)
        .args(["-o"])
        .arg(tmp_pdf)
        .arg(tmp_xml)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            return Err(format!(
                "EXPORT_MUSESCORE_RENDER_FAILED: spawn {}: {e}",
                exe.display()
            ))
        }
    };
    let Some(h) = handle else {
        return child
            .wait()
            .map_err(|e| {
                format!("EXPORT_MUSESCORE_RENDER_FAILED: wait {}: {e}", exe.display())
            });
    };
    {
        let mut slot = h.child.lock().unwrap_or_else(|e| e.into_inner());
        *slot = Some(child);
    }
    let status = loop {
        if h.cancelled.load(Ordering::SeqCst) {
            // Flagged but the child may still be ours — take+kill it.
            let mut slot = h.child.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(mut c) = slot.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            drop(slot);
            return Err("EXPORT_CANCELLED".to_string());
        }
        let done: Option<std::process::ExitStatus> = {
            let mut slot = h.child.lock().unwrap_or_else(|e| e.into_inner());
            match slot.as_mut() {
                Some(c) => match c.try_wait() {
                    Ok(s) => s,
                    Err(e) => {
                        drop(slot);
                        return Err(format!(
                            "EXPORT_MUSESCORE_RENDER_FAILED: wait {}: {e}",
                            exe.display()
                        ));
                    }
                },
                // export_cancel already took+killed the child.
                None => {
                    drop(slot);
                    return Err("EXPORT_CANCELLED".to_string());
                }
            }
        };
        if let Some(s) = done {
            break s;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    {
        let mut slot = h.child.lock().unwrap_or_else(|e| e.into_inner());
        *slot = None;
    }
    Ok(status)
}

/// `open_in_musescore`: stage the score as a temp MusicXML and launch the
/// MuseScore GUI on it (spec 13: 高度編集 → MuseScoreで開く). Unlike
/// `export_run`'s staged PDF renders, the process is not awaited —
/// the user keeps working in MuseScore — so the staged file is left
/// for the OS temp cleaner.
/// A millisecond suffix keeps successive opens (edited score re-opens)
/// from overwriting a file the GUI may still hold.
#[tauri::command]
pub fn open_in_musescore(
    musescore_path: String,
    music_xml: String,
    basename: String,
) -> Result<String, String> {
    let exe = PathBuf::from(&musescore_path);
    if !exe.is_file() {
        return Err("MUSESCORE_UNAVAILABLE".to_string());
    }
    let stem_raw: String = basename
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let stem: &str = if stem_raw.is_empty() {
        "score"
    } else {
        &stem_raw
    };
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let staging =
        std::env::temp_dir().join(format!("hornscribe-open-{}-{}.musicxml", stem, millis));
    std::fs::write(&staging, music_xml.as_bytes())
        .map_err(|e| format!("stage {}: {e}", staging.display()))?;
    std::process::Command::new(&exe)
        .arg(&staging)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", exe.display()))?;
    Ok(staging.to_string_lossy().into_owned())
}

/// Minimal RFC 4648 decoder — avoids a base64 dependency for a
/// few-hundred-KB worst-case payload.
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    fn val(b: u8) -> Result<u8, String> {
        match b {
            b'A'..=b'Z' => Ok(b - b'A'),
            b'a'..=b'z' => Ok(b - b'a' + 26),
            b'0'..=b'9' => Ok(b - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("bad base64 byte {b}")),
        }
    }
    let bytes: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if bytes.len() % 4 != 0 {
        return Err("base64 length not a multiple of 4".into());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().rev().take_while(|&&b| b == b'=').count();
        if pad > 2 {
            return Err("too much base64 padding".into());
        }
        let mut acc: u32 = 0;
        for (i, &b) in chunk.iter().enumerate() {
            let v = if b == b'=' { 0 } else { val(b)? };
            acc |= (v as u32) << (18 - i * 6);
        }
        out.push((acc >> 16) as u8);
        if pad < 2 {
            out.push((acc >> 8) as u8);
        }
        if pad < 1 {
            out.push(acc as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let uniq = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "hornscribe-export-test-{}-{}-{}",
            std::process::id(),
            uniq,
            tag
        ))
    }

    fn b64(s: &str) -> String {
        // Minimal encoder for test payloads (decode_base64 inverse).
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let bytes = s.as_bytes();
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            out.push(T[(n >> 18) as usize & 63] as char);
            out.push(T[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 {
                T[(n >> 6) as usize & 63] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                T[n as usize & 63] as char
            } else {
                '='
            });
        }
        out
    }

    fn file(name: &str, body: &str) -> ExportFile {
        ExportFile {
            name: name.to_string(),
            data_base64: b64(body),
        }
    }

    #[test]
    fn project_write_roundtrip_and_recovery() {
        // #389: the shell save mirrors ProjectStore — the write lands
        // atomically and a re-save keeps the previous body as the
        // sibling .recovery snapshot.
        let dir = tmp_dir("project-write");
        let target = dir.join("take.hornscribe.json");
        let first = "{\"projectId\":\"prj-0123456789abcdef\"}";
        write_project_file(&target, first).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), first);
        let second = "{\"projectId\":\"prj-ffffffffffffffff\"}";
        write_project_file(&target, second).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), second);
        let recovery = dir.join("take.hornscribe.json.recovery");
        assert_eq!(std::fs::read_to_string(&recovery).unwrap(), first);
        assert!(!dir.join("take.hornscribe.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_names_are_validated() {
        assert!(valid_export_name("take_concert.musicxml"));
        assert!(valid_export_name("take_playback.mid"));
        assert!(!valid_export_name("take_source.wav"));
        assert!(!valid_export_name("../evil.musicxml"));
        assert!(!valid_export_name("a/b.pdf"));
        assert!(valid_audio_name("take_source.wav"));
        assert!(!valid_audio_name("take_concert.musicxml"));
        assert!(valid_artifact_name("take_source.mp3"));
        assert!(valid_artifact_name("take_horn_in_f.pdf"));
    }

    #[test]
    fn run_export_commits_all_artifacts() {
        let dir = tmp_dir("commit");
        let src = tmp_dir("commit-src");
        std::fs::create_dir_all(&src).unwrap();
        let audio = src.join("take.wav");
        std::fs::write(&audio, b"RIFF").unwrap();
        let out = run_export(
            &dir,
            Some(ExportAudioCopy {
                name: "take_source.wav".into(),
                src: audio.to_string_lossy().into_owned(),
            }),
            vec![
                file("take_concert.musicxml", "<xml/>"),
                file("take_playback.mid", "MThd"),
            ],
            vec![],
            None,
            None,
        )
        .unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(
            std::fs::read(dir.join("take_concert.musicxml")).unwrap(),
            b"<xml/>"
        );
        assert_eq!(std::fs::read(dir.join("take_source.wav")).unwrap(), b"RIFF");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&src);
    }

    #[test]
    fn run_export_failure_leaves_destination_untouched() {
        // #258: a mid-batch failure must not leave the first artifact
        // behind — staging is cleaned and nothing reaches the dest.
        let dir = tmp_dir("atomic");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("keep.txt"), b"old").unwrap();
        let err = run_export(
            &dir,
            None,
            vec![
                file("take_concert.musicxml", "<xml/>"),
                ExportFile {
                    name: "take_playback.mid".into(),
                    data_base64: "!!!bad".into(),
                },
            ],
            vec![],
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("take_playback.mid"));
        assert!(!dir.join("take_concert.musicxml").exists());
        assert!(!dir.join("take_playback.mid").exists());
        assert_eq!(std::fs::read(dir.join("keep.txt")).unwrap(), b"old");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_export_pdf_without_musescore_fails_before_writes() {
        let dir = tmp_dir("pdf");
        let err = run_export(
            &dir,
            None,
            vec![file("take_concert.musicxml", "<xml/>")],
            vec![ExportRunPdf {
                name: "take_concert.pdf".into(),
                music_xml: "<xml/>".into(),
            }],
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(err, "MUSESCORE_UNAVAILABLE");
        assert!(!dir.join("take_concert.musicxml").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_export_pre_cancelled_writes_nothing() {
        // #383: a cancelled run commits no artifacts — the flag is
        // checked at every stage boundary.
        let dir = tmp_dir("cancel");
        std::fs::create_dir_all(&dir).unwrap();
        let handle = ExportHandle {
            cancelled: AtomicBool::new(true),
            child: Mutex::new(None),
        };
        let err = run_export(
            &dir,
            None,
            vec![file("take_concert.musicxml", "<xml/>")],
            vec![],
            None,
            Some(&handle),
        )
        .unwrap_err();
        assert_eq!(err, "EXPORT_CANCELLED");
        assert!(!dir.join("take_concert.musicxml").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_cancel_unknown_id_is_noop() {
        // A stale/late cancel must not fail — the run already finished.
        assert!(export_cancel("hornscribe-export-nope".to_string()).is_ok());
    }
}
