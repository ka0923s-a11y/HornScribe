//! ENG-002: spawn the Python engine sidecar (`python -m hornscribe.worker`)
//! and relay its NDJSON protocol to the frontend over a Tauri channel.
//!
//! Security model (same pattern as lib.rs's self-limiting commands): the
//! spawned process is always the fixed `hornscribe.worker` protocol —
//! the frontend cannot choose the program, the arguments, or the cwd.
//! The engine resolves in this order (#83):
//!
//! 1. `HORNSCRIBE_ENGINE` — path to a frozen engine binary
//!    (explicit operator override, speaks NDJSON directly);
//! 2. `HORNSCRIBE_PYTHON` — interpreter override (dev/debug);
//! 3. a bundled `engine/hornscribe-engine[.exe]` next to the app
//!    resources or the executable (packaged builds);
//! 4. repo-local virtualenvs found by walking ancestors of
//!    `CARGO_MANIFEST_DIR` for `.venv-*/Scripts/python.exe` /
//!    `.venv/Scripts/python.exe` (dev checkouts);
//! 5. `python`/`py -3` on PATH (system installs).
//!
//! `HORNSCRIBE_PYTHONPATH` overrides the module search path; otherwise the
//! repo's `python/` directory (the `hornscribe` package root) is injected
//! when it exists. Frozen binaries ignore PYTHONPATH entirely.
//!
//! Channel protocol (one JSON object per send):
//!   `{kind:"line",   line}`   — one stdout NDJSON frame
//!   `{kind:"stderr", line}`   — one stderr line (diagnostics only)
//!   `{kind:"exit",   code}`   — process exited; `code` may be null

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde_json::json;
use tauri::ipc::Channel;

use crate::tools::which_exists;

/// The single in-flight engine process. One sidecar per app — the worker
/// itself enforces one job at a time (PROTOCOL.md).
struct EngineState {
    child: Child,
    /// `Option` so `engine_close_stdin` can take()+drop it — dropping the
    /// pipe is the EOF the worker treats as a graceful shutdown.
    stdin: Option<ChildStdin>,
}

static ENGINE: Mutex<Option<EngineState>> = Mutex::new(None);

/// How the engine process is launched (#83). A frozen binary speaks the
/// worker NDJSON protocol directly; a Python interpreter is invoked as
/// `python -m hornscribe.worker` with an optional PYTHONPATH.
enum SpawnTarget {
    Binary(PathBuf),
    Python { exe: PathBuf, pythonpath: Option<PathBuf> },
}

/// `engine_spawn`: start the sidecar; stream frames over `channel`.
/// Fails with a human-readable string when no usable Python is found.
#[tauri::command]
pub fn engine_spawn(
    channel: Channel<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut guard = ENGINE.lock().map_err(|_| "engine lock")?;
    if guard.is_some() {
        return Err("ENGINE_ALREADY_RUNNING".to_string());
    }
    let target = resolve_engine(&app)?;

    let mut cmd = match &target {
        SpawnTarget::Binary(exe) => Command::new(exe),
        SpawnTarget::Python { exe, pythonpath } => {
            let mut c = Command::new(exe);
            c.args(["-m", "hornscribe.worker"]);
            if let Some(pp) = pythonpath {
                c.env("PYTHONPATH", pp);
            }
            c
        }
    };
    cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // The worker pins its own UTF-8/\n streams; unbuffered keeps
        // progress frames flowing without relying on flush timing.
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONUTF8", "1");
    // #10/#11: a bundled tools/ dir must be visible inside the engine
    // too — audioread/demucs resolve ffmpeg through PATH in the child,
    // so prepend the same dirs resolve_ffmpeg probes. Inherited PATH
    // stays as fallback; nothing breaks when tools/ is absent.
    let tool_dirs = crate::tools::bundled_tools_dirs(&app);
    if !tool_dirs.is_empty() {
        let mut paths = tool_dirs;
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
    // No console window flash on Windows for the spawned interpreter.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| {
            let exe = match &target {
                SpawnTarget::Binary(p) | SpawnTarget::Python { exe: p, .. } => p.clone(),
            };
            format!("spawn {}: {e}", exe.display())
        })?;
    let stdin = child
        .stdin
        .take()
        .ok_or("child stdin was not piped")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("child stdout was not piped")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("child stderr was not piped")?;

    // stdout -> protocol lines.
    let line_chan = channel.clone();
    std::thread::Builder::new()
        .name("hornscribe-engine-stdout".into())
        .spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) if !l.is_empty() => {
                        let _ = line_chan.send(json!({"kind":"line","line":l}));
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| format!("spawn stdout reader: {e}"))?;

    // stderr -> diagnostics lines + a persistent per-spawn log file
    // (#403: 診断情報 の ログフォルダを開く needs a real file to show).
    let err_chan = channel.clone();
    let mut log_file = crate::diagnostics::engine_log_file(&app);
    std::thread::Builder::new()
        .name("hornscribe-engine-stderr".into())
        .spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(l) if !l.is_empty() => {
                        if let Some(f) = log_file.as_mut() {
                            let _ = writeln!(f, "{l}");
                        }
                        let _ = err_chan.send(json!({"kind":"stderr","line":l}));
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| format!("spawn stderr reader: {e}"))?;

    *guard = Some(EngineState {
        child,
        stdin: Some(stdin),
    });
    drop(guard);

    // Exit monitor: try_wait on a short poll so engine_kill stays
    // responsive (a blocking wait() would hold the child forever).
    std::thread::Builder::new()
        .name("hornscribe-engine-exit".into())
        .spawn(move || loop {
            let exited = {
                let mut guard = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
                match guard.as_mut() {
                    Some(state) => match state.child.try_wait() {
                        Ok(Some(status)) => {
                            *guard = None;
                            Some(status.code())
                        }
                        Ok(None) => None,
                        Err(_) => {
                            *guard = None;
                            Some(None)
                        }
                    },
                    // Engine was killed/closed from the frontend.
                    None => return,
                }
            };
            match exited {
                Some(code) => {
                    let _ = channel.send(json!({"kind":"exit","code":code}));
                    return;
                }
                None => std::thread::sleep(std::time::Duration::from_millis(40)),
            }
        })
        .map_err(|e| format!("spawn exit monitor: {e}"))?;

    Ok(())
}

/// `engine_write`: one NDJSON request line to the worker's stdin.
#[tauri::command]
pub fn engine_write(line: String) -> Result<(), String> {
    let mut guard = ENGINE.lock().map_err(|_| "engine lock")?;
    let state = guard.as_mut().ok_or("ENGINE_NOT_RUNNING")?;
    let stdin = state.stdin.as_mut().ok_or("engine stdin is closed")?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|()| stdin.write_all(b"\n"))
        .and_then(|()| stdin.flush())
        .map_err(|e| format!("engine stdin: {e}"))
}

/// `engine_close_stdin`: drop stdin so the worker sees EOF and performs
/// its graceful shutdown (worker.py contract).
#[tauri::command]
pub fn engine_close_stdin() -> Result<(), String> {
    let mut guard = ENGINE.lock().map_err(|_| "engine lock")?;
    if let Some(state) = guard.as_mut() {
        drop(state.stdin.take());
    }
    Ok(())
}

/// `engine_kill`: terminate the sidecar immediately (the documented
/// terminate/restart fallback for non-interruptible jobs).
#[tauri::command]
pub fn engine_kill() -> Result<(), String> {
    let mut guard = ENGINE.lock().map_err(|_| "engine lock")?;
    if let Some(mut state) = guard.take() {
        let _ = state.child.kill();
        let _ = state.child.wait();
    }
    Ok(())
}

/// App-exit cleanup: never leak the sidecar past the shell process.
pub fn kill_engine_on_exit() {
    if let Ok(mut guard) = ENGINE.lock() {
        if let Some(mut state) = guard.take() {
            let _ = state.child.kill();
            let _ = state.child.wait();
        }
    }
}

/// Resolve how to launch the engine (#83). Returns either a frozen
/// binary or a Python interpreter + module path. The `pythonpath` is
/// `None` when the interpreter already has `hornscribe` importable
/// (venv installs) — frozen binaries never see it.
fn resolve_engine(app: &tauri::AppHandle) -> Result<SpawnTarget, String> {
    let repo_python_dir = find_repo_python_dir();

    // #83: explicit frozen-engine override wins — a packaged layout can
    // also point at a portable binary via env without rebuilding.
    if let Ok(explicit) = std::env::var("HORNSCRIBE_ENGINE") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Ok(SpawnTarget::Binary(p));
        }
        return Err(format!("HORNSCRIBE_ENGINE is not a file: {}", p.display()));
    }

    if let Ok(explicit) = std::env::var("HORNSCRIBE_PYTHON") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Ok(SpawnTarget::Python {
                exe: p,
                pythonpath: repo_python_dir,
            });
        }
        return Err(format!("HORNSCRIBE_PYTHON is not a file: {}", p.display()));
    }

    // #83: bundled frozen engine (packaged builds). Checked before the
    // dev venvs so an installed app never reaches into a source checkout.
    for candidate in bundled_engine_paths(app) {
        if candidate.is_file() {
            return Ok(SpawnTarget::Binary(candidate));
        }
    }

    // Repo-local venvs (dev checkouts and the bundled `engine/` layout).
    for candidate in local_venv_pythons() {
        if candidate.is_file() {
            return Ok(SpawnTarget::Python {
                exe: candidate,
                pythonpath: repo_python_dir.clone(),
            });
        }
    }

    // PATH fallbacks: `python` then the `py` launcher.
    for exe in ["python", "py"] {
        if which_exists(exe) {
            return Ok(SpawnTarget::Python {
                exe: PathBuf::from(exe),
                pythonpath: repo_python_dir,
            });
        }
    }
    Err(
        "no engine runtime found (bundle engine/hornscribe-engine, set \
         HORNSCRIBE_ENGINE/HORNSCRIBE_PYTHON, or install the engine environment)"
            .to_string(),
    )
}

/// Candidate locations for the frozen engine binary (#83).
///
/// Packaged builds ship `engine/hornscribe-engine[.exe]` as a Tauri
/// resource (see scripts/build_engine.py + tauri.conf.json). The exact
/// resource_dir layout varies by installer, so we probe the resource
/// dir, its `resources/` child, and the executable's own directory —
/// the last also covers portable-zip layouts without an installer.
fn bundled_engine_paths(app: &tauri::AppHandle) -> Vec<PathBuf> {
    const EXE: &str = if cfg!(windows) {
        "hornscribe-engine.exe"
    } else {
        "hornscribe-engine"
    };
    // #10: same roots as tools::bundled_tools_dirs — one probe order
    // for every bundled resource.
    crate::tools::bundled_roots(app)
        .into_iter()
        .map(|root| root.join("engine").join(EXE))
        .collect()
}

/// `<repo>/python` — the hornscribe package root — found by walking up
/// from the crate manifest. `HORNSCRIBE_PYTHONPATH` wins when set.
fn find_repo_python_dir() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("HORNSCRIBE_PYTHONPATH") {
        let p = PathBuf::from(explicit);
        if p.is_dir() {
            return Some(p);
        }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for dir in manifest.ancestors() {
        let candidate = dir.join("python").join("hornscribe");
        if candidate.is_dir() {
            return Some(dir.join("python"));
        }
    }
    None
}

/// Repo-local virtualenv interpreters, best-first. The worker
/// hard-requires music21 and benefits from basic_pitch, so envs are
/// scored by what they can actually run: a stale basic-pitch-only env
/// (no music21) would crash the worker on import and must rank below a
/// plain `.venv` that can at least serve the engine honestly.
fn local_venv_pythons() -> Vec<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut roots: Vec<PathBuf> = Vec::new();
    for dir in manifest.ancestors() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with(".venv") && entry.path().is_dir() {
                    roots.push(entry.path());
                }
            }
        }
    }
    // Score by installed packages: music21 is a hard import, basic_pitch
    // unlocks the real model. Best score first; name tiebreak keeps
    // dev runs deterministic.
    let site_has = |v: &Path, pkg: &str| {
        v.join("Lib").join("site-packages").join(pkg).is_dir()
    };
    let score = |v: &Path| {
        (!site_has(v, "music21") as u8) * 2 + (!site_has(v, "basic_pitch") as u8)
    };
    roots.sort_by(|a, b| {
        score(a).cmp(&score(b)).then_with(|| {
            a.file_name()
                .unwrap_or_default()
                .cmp(b.file_name().unwrap_or_default())
        })
    });
    roots
        .into_iter()
        .map(|v| v.join("Scripts").join("python.exe"))
        .collect()
}
