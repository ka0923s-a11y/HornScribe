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
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;
use std::sync::Mutex;

use serde_json::json;
use tauri::ipc::Channel;

use crate::tools::which_exists;

/// The single in-flight engine process. One sidecar per app — the worker
/// itself enforces one job at a time (PROTOCOL.md).
struct EngineState {
    child: Child,
    /// #179: request lines go through an mpsc channel drained by a
    /// dedicated stdin writer thread — `engine_write` never blocks the
    /// UI on a full pipe (sync commands run on the main thread).
    /// `Option` lets `engine_close_stdin` take()+drop the sender: the
    /// writer exits, `ChildStdin` drops, and the worker sees the EOF it
    /// treats as a graceful shutdown.
    stdin_tx: Option<Sender<String>>,
    /// #185: Job Object with KILL_ON_JOB_CLOSE — the PyInstaller
    /// onefile bootloader re-execs the real worker as a grandchild,
    /// and Windows auto-enrolls descendants of a job member, so this
    /// handle's close ends the WHOLE tree on every path: engine_kill,
    /// exit cleanup, even a shell crash. `None` degrades to the
    /// taskkill fallback inside reap_child.
    _job: ProcessGuard,
}

static ENGINE: Mutex<Option<EngineState>> = Mutex::new(None);

/// #185: a Job Object held for the engine's whole lifetime. Windows
/// auto-enrolls a job member's descendants, so PyInstaller's re-exec'd
/// worker lands inside the same job; KILL_ON_JOB_CLOSE ends the whole
/// tree the moment our handle closes — engine_kill, exit cleanup, or
/// a shell crash. `None` degrades to the taskkill fallback in
/// reap_child when job setup fails.
#[cfg(windows)]
struct ProcessGuard(
    #[allow(dead_code)]
    Option<windows_core::Owned<windows::Win32::Foundation::HANDLE>>,
);

// #185: HANDLE is a raw pointer so ProcessGuard is not auto-Send —
// but the handle is only ever closed on Drop, never dereferenced or
// shared, so moving it across threads is sound.
#[cfg(windows)]
unsafe impl Send for ProcessGuard {}

#[cfg(windows)]
impl ProcessGuard {
    fn for_child(child: &Child) -> Self {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JobObjectExtendedLimitInformation, SetInformationJobObject,
        };
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };
        unsafe {
            let job = match CreateJobObjectW(None, windows::core::PCWSTR::null()) {
                Ok(h) if !h.is_invalid() => h,
                _ => return Self(None),
            };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let armed = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .is_ok();
            if !armed {
                let _ = CloseHandle(job);
                return Self(None);
            }
            let proc = match OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                false,
                child.id(),
            ) {
                Ok(p) => p,
                Err(_) => {
                    let _ = CloseHandle(job);
                    return Self(None);
                }
            };
            let assigned = AssignProcessToJobObject(job, proc).is_ok();
            let _ = CloseHandle(proc);
            if !assigned {
                let _ = CloseHandle(job);
                return Self(None);
            }
            Self(Some(windows_core::Owned::new(job)))
        }
    }
}

#[cfg(not(windows))]
struct ProcessGuard;

#[cfg(not(windows))]
impl ProcessGuard {
    fn for_child(_child: &Child) -> Self {
        Self
    }
}

/// How the engine process is launched (#83). A frozen binary speaks the
/// worker NDJSON protocol directly; a Python interpreter is invoked as
/// `python -m hornscribe.worker` with an optional PYTHONPATH.
enum SpawnTarget {
    Binary(PathBuf),
    Python { exe: PathBuf, pythonpath: Option<PathBuf> },
}

/// `engine_spawn`: start the sidecar; stream frames over `channel`.
/// Fails with a human-readable string when no usable Python is found.
/// #179: async — resolve+spawn probe the filesystem and launch a
/// process, which must not stall the UI thread (sync commands run
/// there).
#[tauri::command]
pub async fn engine_spawn(
    channel: Channel<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || engine_spawn_impl(channel, app))
        .await
        .map_err(|e| format!("engine spawn task: {e}"))?
}

fn engine_spawn_impl(
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

    // #179: the stdin writer thread owns the pipe — a worker that stops
    // reading stdin parks this thread, never the UI. The channel ending
    // (close_stdin / kill / exit) exits the loop and drops the pipe,
    // which is the EOF the worker treats as a graceful shutdown.
    let (stdin_tx, stdin_rx) = std::sync::mpsc::channel::<String>();
    let writer = std::thread::Builder::new()
        .name("hornscribe-engine-stdin".into())
        .spawn(move || {
            let mut stdin = stdin;
            for line in stdin_rx.iter() {
                let written = stdin
                    .write_all(line.as_bytes())
                    .and_then(|()| stdin.write_all(b"\n"))
                    .and_then(|()| stdin.flush());
                if written.is_err() {
                    // Dead pipe — the exit monitor reports the process end.
                    break;
                }
            }
        });
    if let Err(e) = writer {
        // A running child with no writer would leak — kill it now.
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("spawn stdin writer: {e}"));
    }

    // #185: assign the job BEFORE moving `child` into the state — the
    // guard borrows the handle. Jobs auto-enroll the child's future
    // descendants (PyInstaller's re-exec'd worker lands inside).
    let _job = ProcessGuard::for_child(&child);
    *guard = Some(EngineState {
        child,
        _job,
        stdin_tx: Some(stdin_tx),
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

/// `engine_write`: queue one NDJSON request line for the worker's stdin.
/// #179: the actual pipe write happens on the writer thread — this
/// returns in microseconds even when the worker's stdin buffer is full,
/// so a busy engine can never freeze the UI (previously a blocking
/// `write_all` on the main thread). FIFO order is preserved.
#[tauri::command]
pub fn engine_write(line: String) -> Result<(), String> {
    let guard = ENGINE.lock().map_err(|_| "engine lock")?;
    let state = guard.as_ref().ok_or("ENGINE_NOT_RUNNING")?;
    match &state.stdin_tx {
        Some(tx) => tx
            .send(line)
            .map_err(|_| "engine stdin is closed".to_string()),
        None => Err("engine stdin is closed".to_string()),
    }
}

/// `engine_close_stdin`: drop the sender so the writer thread exits and
/// closes the pipe — the worker sees EOF and performs its graceful
/// shutdown (worker.py contract).
#[tauri::command]
pub fn engine_close_stdin() -> Result<(), String> {
    let mut guard = ENGINE.lock().map_err(|_| "engine lock")?;
    if let Some(state) = guard.as_mut() {
        drop(state.stdin_tx.take());
    }
    Ok(())
}

/// #179: bounded reap — `wait()` can park forever if the OS wedges the
/// child; try_wait with a ~3 s cap keeps engine_kill and the Exit
/// handler from ever hanging the shell process.
fn reap_child(child: &mut Child) {
    kill_process_tree(child);
    for _ in 0..60 {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
}

/// #185: end the whole engine process tree, not just the direct child.
/// The frozen engine is a PyInstaller onefile bundle whose bootloader
/// re-execs the real Python worker as a grandchild — `child.kill()`
/// ends only the bootloader and orphans the worker (~300 MB plus its
/// cache handles, still running any job). `taskkill /T /F` walks the
/// tree; the extra `child.kill()` is a harmless belt on top.
#[cfg(windows)]
fn kill_process_tree(child: &mut Child) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let _ = child.kill();
}

#[cfg(not(windows))]
fn kill_process_tree(child: &mut Child) {
    let _ = child.kill();
}

/// `engine_kill`: terminate the sidecar immediately (the documented
/// terminate/restart fallback for non-interruptible jobs). #179: runs
/// on spawn_blocking so the reap never parks the UI thread.
#[tauri::command]
pub async fn engine_kill() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut guard = ENGINE.lock().map_err(|_| "engine lock")?;
        if let Some(mut state) = guard.take() {
            drop(state.stdin_tx.take());
            reap_child(&mut state.child);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("engine kill task: {e}"))?
}

/// App-exit cleanup: never leak the sidecar past the shell process.
/// #179: bounded reap — the RunEvent::Exit handler must return for the
/// process to die; a wedged child must not turn the shell into a
/// zombie.
pub fn kill_engine_on_exit() {
    if let Ok(mut guard) = ENGINE.lock() {
        if let Some(mut state) = guard.take() {
            drop(state.stdin_tx.take());
            reap_child(&mut state.child);
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
/// resource — #186 moved to a PyInstaller ONEDIR bundle, so the exe
/// now nests under `engine/hornscribe-engine/`; the exact resource_dir
/// layout varies by installer, so we probe the resource dir, its
/// `resources/` child, and the executable's own directory — the last
/// also covers portable-zip layouts without an installer. The flat
/// onefile path stays last for older layouts and dev trees.
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
        .flat_map(|root| [
            root.join("engine").join("hornscribe-engine").join(EXE),
            root.join("engine").join(EXE),
        ])
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

#[cfg(test)]
mod tests {
    use super::*;

    /// #179: with no engine the write path must fail fast — the guard
    /// state drives the error, nothing ever blocks.
    #[test]
    fn engine_write_without_engine_is_an_error() {
        let prev = ENGINE.lock().unwrap().take();
        let r = engine_write("{\"id\":\"x\"}".into());
        *ENGINE.lock().unwrap() = prev;
        assert_eq!(r.unwrap_err(), "ENGINE_NOT_RUNNING");
    }

    /// #179 regression: a worker that never drains stdin must not make
    /// the send path park the caller. Drives the real writer-thread +
    /// channel pair against a child whose pipe buffer fills up.
    #[test]
    #[cfg(windows)]
    fn stdin_writer_never_blocks_sender() {
        let mut child = Command::new("powershell")
            .args(["-NoProfile", "-Command", "Start-Sleep", "-Seconds", "20"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleeper");
        let stdin = child.stdin.take().expect("piped stdin");
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let writer = std::thread::spawn(move || {
            let mut stdin = stdin;
            for line in rx.iter() {
                if stdin
                    .write_all(line.as_bytes())
                    .and_then(|()| stdin.write_all(b"\n"))
                    .and_then(|()| stdin.flush())
                    .is_err()
                {
                    break;
                }
            }
        });
        // 32 MiB of request lines — far beyond any pipe buffer; if the
        // send path ever touched the pipe this would take far longer.
        let big = "x".repeat(8 * 1024 * 1024);
        let t0 = std::time::Instant::now();
        for _ in 0..4 {
            tx.send(big.clone()).unwrap();
        }
        assert!(
            t0.elapsed() < std::time::Duration::from_secs(2),
            "channel send blocked on a full pipe: {:?}",
            t0.elapsed()
        );
        // Kill first so the writer's pending write fails and exits,
        // then close the channel and join.
        let _ = child.kill();
        let _ = child.wait();
        drop(tx);
        let _ = writer.join();
    }
}
