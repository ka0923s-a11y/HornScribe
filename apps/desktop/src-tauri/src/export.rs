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

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// Artifact extensions the export flow may write (§17 formats).
const EXPORT_EXTENSIONS: [&str; 4] = ["musicxml", "xml", "mid", "pdf"];

/// Directories the user explicitly picked via `export_pick_dir` this
/// session — the write side of the self-limiting model.
static GRANTED_DIRS: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

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

/// `export_write_files`: write the export artifacts into `dir`.
/// Creates the directory when missing; overwrites same-named artifacts
/// (a re-export is an explicit user action). Fails with
/// `PERMISSION_DENIED` for un-granted destinations.
#[tauri::command]
pub fn export_write_files(
    app: tauri::AppHandle,
    dir: String,
    files: Vec<ExportFile>,
) -> Result<Vec<String>, String> {
    let dir_path = PathBuf::from(&dir);
    if !dir_allowed(&app, &dir_path) {
        return Err("PERMISSION_DENIED".to_string());
    }
    std::fs::create_dir_all(&dir_path)
        .map_err(|e| format!("create {}: {e}", dir_path.display()))?;
    let mut written = Vec::with_capacity(files.len());
    for file in files {
        if !valid_export_name(&file.name) {
            return Err(format!("invalid export name: {}", file.name));
        }
        let bytes = decode_base64(&file.data_base64)
            .map_err(|e| format!("{}: {e}", file.name))?;
        let path = dir_path.join(&file.name);
        std::fs::write(&path, &bytes)
            .map_err(|e| format!("write {}: {e}", path.display()))?;
        written.push(path.to_string_lossy().into_owned());
    }
    Ok(written)
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

/// `reveal_in_explorer`: open a directory in the OS file manager.
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
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

/// `render_pdf`: run MuseScore headless (`-o out.pdf score.musicxml`).
/// The MusicXML arrives as text; it is staged in the temp dir, rendered,
/// then removed. `out_path` must satisfy the same destination rules as
/// `export_write_files`.
#[tauri::command]
pub fn render_pdf(
    app: tauri::AppHandle,
    musescore_path: String,
    music_xml: String,
    out_path: String,
) -> Result<String, String> {
    let exe = PathBuf::from(&musescore_path);
    if !exe.is_file() {
        return Err("MUSESCORE_UNAVAILABLE".to_string());
    }
    let out = PathBuf::from(&out_path);
    let parent = out.parent().ok_or("out path has no directory")?;
    if !dir_allowed(&app, parent) {
        return Err("PERMISSION_DENIED".to_string());
    }
    if out.extension().and_then(|e| e.to_str()) != Some("pdf") {
        return Err("out path must end in .pdf".to_string());
    }
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("create {}: {e}", parent.display()))?;

    let staging = std::env::temp_dir().join(format!(
        "hornscribe-export-{}-{}.musicxml",
        std::process::id(),
        out.file_stem().and_then(|s| s.to_str()).unwrap_or("score")
    ));
    std::fs::write(&staging, music_xml.as_bytes())
        .map_err(|e| format!("stage {}: {e}", staging.display()))?;

    let status = std::process::Command::new(&exe)
        .args(["-o"])
        .arg(&out)
        .arg(&staging)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let _ = std::fs::remove_file(&staging);
    match status {
        Ok(s) if s.success() && out.is_file() => {
            Ok(out.to_string_lossy().into_owned())
        }
        Ok(s) => Err(format!("MuseScore exited with {s}")),
        Err(e) => Err(format!("spawn {}: {e}", exe.display())),
    }
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
    let bytes: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
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
