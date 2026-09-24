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

/// Audio extensions the sourceAudio bundle may copy (#87).
const AUDIO_EXTENSIONS: [&str; 5] = ["wav", "mp3", "flac", "m4a", "ogg"];

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
            return Err(format!("invalid export name: {}", name));
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
) -> Result<Vec<String>, String> {
    let dir_path = PathBuf::from(&dir);
    if !dir_allowed(&app, &dir_path) {
        return Err("PERMISSION_DENIED".to_string());
    }
    run_export(&dir_path, audio, files, pdfs, musescore_path)
}

/// The transactional body of `export_run`, split from the AppHandle
/// wrapper so the stage→commit flow is unit-testable (#258).
fn run_export(
    dir_path: &Path,
    audio: Option<ExportAudioCopy>,
    files: Vec<ExportFile>,
    pdfs: Vec<ExportRunPdf>,
    musescore_path: Option<String>,
) -> Result<Vec<String>, String> {
    // Validate everything before touching the filesystem — a bad name
    // must not leave a half-staged directory behind.
    for f in &files {
        if !valid_export_name(&f.name) {
            return Err(format!("invalid export name: {}", f.name));
        }
    }
    for p in &pdfs {
        if !valid_export_name(&p.name) || !p.name.to_ascii_lowercase().ends_with(".pdf") {
            return Err(format!("invalid export name: {}", p.name));
        }
    }
    if let Some(a) = &audio {
        if !valid_audio_name(&a.name) {
            return Err(format!("invalid export name: {}", a.name));
        }
        if !PathBuf::from(&a.src).is_file() {
            return Err(format!("source audio not found: {}", a.src));
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
    std::fs::create_dir_all(dir_path).map_err(|e| format!("create {}: {e}", dir_path.display()))?;

    let uniq = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let staging =
        std::env::temp_dir().join(format!("hornscribe-export-{}-{}", std::process::id(), uniq));
    let result = (|| -> Result<Vec<String>, String> {
        std::fs::create_dir_all(&staging)
            .map_err(|e| format!("stage {}: {e}", staging.display()))?;
        let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
        if let Some(a) = &audio {
            let src = PathBuf::from(&a.src);
            let tmp = staging.join(&a.name);
            std::fs::copy(&src, &tmp).map_err(|e| format!("copy {}: {e}", tmp.display()))?;
            staged.push((tmp, dir_path.join(&a.name)));
        }
        for f in &files {
            let bytes = decode_base64(&f.data_base64).map_err(|e| format!("{}: {e}", f.name))?;
            let tmp = staging.join(&f.name);
            std::fs::write(&tmp, &bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
            staged.push((tmp, dir_path.join(&f.name)));
        }
        if let Some(exe) = &exe {
            for p in &pdfs {
                let tmp_xml = staging.join(format!("{}.musicxml", p.name));
                std::fs::write(&tmp_xml, p.music_xml.as_bytes())
                    .map_err(|e| format!("stage {}: {e}", tmp_xml.display()))?;
                let tmp_pdf = staging.join(&p.name);
                let status = std::process::Command::new(exe)
                    .args(["-o"])
                    .arg(&tmp_pdf)
                    .arg(&tmp_xml)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
                let _ = std::fs::remove_file(&tmp_xml);
                match status {
                    Ok(s) if s.success() && tmp_pdf.is_file() => {}
                    Ok(s) => {
                        return Err(format!("MuseScore exited with {s}"));
                    }
                    Err(e) => {
                        return Err(format!("spawn {}: {e}", exe.display()));
                    }
                }
                staged.push((tmp_pdf, dir_path.join(&p.name)));
            }
        }
        let mut out = Vec::with_capacity(staged.len());
        for (tmp, dest) in staged {
            if dest.exists() {
                let _ = std::fs::remove_file(&dest);
            }
            match std::fs::rename(&tmp, &dest) {
                Ok(()) => {}
                Err(_) => {
                    std::fs::copy(&tmp, &dest)
                        .map_err(|e| format!("write {}: {e}", dest.display()))?;
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
        )
        .unwrap_err();
        assert_eq!(err, "MUSESCORE_UNAVAILABLE");
        assert!(!dir.join("take_concert.musicxml").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
