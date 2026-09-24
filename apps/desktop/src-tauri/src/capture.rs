//! FEAT-001 (#60): PC 再生音源(WASAPI ループバック)とマイクの録音。
//!
//! WebView2 では `getDisplayMedia` が使えないため、Tauri の app-defined
//! コマンド経由で WASAPI を直接叩く(ADR-0002 の自己制限コマンドと同じ
//! パターン: ACL は app-defined コマンドをカバーしないので、ここでは
//! 「録音対象=ループバックor既定マイクのみ」「上限時間あり」「WAV のみ
//! 返す」という形に制限を内蔵する)。
//!
//! 録音はバックグラウンドスレッド + `IAudioClient`/`IAudioCaptureClient`
//! ポーリング。`capture_stop` で停止して WAV を appDataDir/recordings/
//! に保存しパスを返す(#70: プロジェクトの sourceAudio に載せられる
//! 実ファイルにするため)。`capture_cancel` で捨てる。デバイスは
//! `capture_devices` で列挙したエンドポイント ID を選べる(#73)。
//! 同時に 1 セッションのみ。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;

/// 録音ソース。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureSource {
    /// 既定のレンダー出力をそのまま取り込む(ループバック)。
    Loopback,
    /// 既定のキャプチャ(マイク)を取り込む。
    Microphone,
}

impl CaptureSource {
    fn data_flow(self) -> windows::Win32::Media::Audio::EDataFlow {
        match self {
            CaptureSource::Loopback => eRender,
            CaptureSource::Microphone => eCapture,
        }
    }
    fn stream_flags(self) -> u32 {
        match self {
            CaptureSource::Loopback => AUDCLNT_STREAMFLAGS_LOOPBACK,
            CaptureSource::Microphone => 0,
        }
    }
    /// UI/診断で使う正規化名("loopback" | "microphone")。
    fn canonical_name(self) -> &'static str {
        match self {
            CaptureSource::Loopback => "loopback",
            CaptureSource::Microphone => "microphone",
        }
    }
}

/// `capture_start` の返り値 — UI はこれで「取り込み中」状態を作る。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSessionInfo {
    /// "loopback" | "microphone" — UI の日本語コピー切り替えに使う。
    pub source: String,
    /// デバイス表示名(診断/ステータス向け。ユーザー向け本文には出さない)。
    pub device_name: String,
    /// 実際に流れるサンプルレート(共有モードの mix 形式)。
    pub sample_rate: u32,
    pub channels: u16,
}

/// `capture_stop` の返り値 — 保存先パス + 基本メタ。WAV 本体は
/// appDataDir/recordings/ に書き出す(#70: 録音をプロジェクトの
/// sourceAudio として永続化・リリンク可能にするため実ファイルにする)。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    /// 保存した WAV の絶対パス。フロントは `read_audio_bytes` で読める。
    pub path: String,
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub channels: u16,
    /// 無音率(0.0–1.0)。全く音が無かった時に UI が「無音でした」を出せる。
    pub silent_ratio: f64,
    /// 30分の上限で自動停止したか。UI が「上限に達した」と伝えるため。
    pub limit_reached: bool,
}

/// `capture_devices` の1項目 — メニューのデバイス選択肢。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDevice {
    /// WASAPI エンドポイント ID(`capture_start` の `device_id` に渡す)。
    pub id: String,
    pub name: String,
    /// このデバイスが現在の既定か。
    pub is_default: bool,
}

/// ワーカースレッドに渡される共有状態。
struct SharedBuf {
    /// f32 サンプル(インターリーブ済み)。上限で切り詰める。
    samples: VecDeque<f32>,
    /// `true` でワーカーが終了処理に入る(取得ループを抜ける)。
    stopping: bool,
    /// `true` で取得を一時停止(#80)。停止中はクライアントを止めて
    /// パケットを捨てる — 再開後に「止めていた間の音」が紛れ込まない
    /// よう、一時停止は録音ギャップとして正直に扱う。
    paused: bool,
    /// ワーカーからの致命的エラーメッセージ(診断に流す)。
    error: Option<String>,
    /// 取り込み済みフレーム数(経過時間表示用)。
    frames: u64,
    /// 無音とみなしたフレーム数(|v| < -60dBFS)。
    silent_frames: u64,
    /// バッファ上限(MAX_SECONDS)に達して自動停止した。
    limit_reached: bool,
    /// 直近パケットのピーク(0.0–1.0)。status ポーリングで減衰させる
    /// 簡易レベルメーター(#71)。
    level: f32,
}

/// 進行中の録音セッション。`capture_start` で生成、stop/cancel で消費。
struct ActiveSession {
    info: CaptureSessionInfo,
    shared: Arc<Mutex<SharedBuf>>,
    cancel: Arc<AtomicBool>,
    handle: std::thread::JoinHandle<()>,
    /// UI が提示した保存ファイル名(#70: 表示名と保存名を一致させる)。
    suggested_name: String,
}

/// 全プロセスで 1 本だけ進行できる録音セッション。
static SESSION: Mutex<Option<ActiveSession>> = Mutex::new(None);

/// 上限: 連続録音 30 分(大きな演奏動画の取り込みを想定しつつ、
/// メモリを守る上限 — 48kHz f32 stereo で ~1.3GB になる前に切る)。
const MAX_SECONDS: u32 = 30 * 60;
/// 上限に達したときのバッファ保持用余剰(ドリフト吸収)。
const MAX_SECONDS_SLACK: u32 = 5;

fn hresult_message(err: &windows::core::Error) -> String {
    format!("HRESULT 0x{:08X}", err.code().0 as u32)
}

/// キャプチャ状態(アイドル/取り込み中) — UI がボタン表示を切り替える。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub active: bool,
    /// `active` の時だけ有意値。
    pub source: Option<String>,
    pub elapsed_seconds: Option<f64>,
    pub device_name: Option<String>,
    /// 直近の入力ピーク(0.0–1.0)。ポーリング毎に減衰する簡易メーター。
    pub level: Option<f32>,
    /// 一時停止中か(#80)。経過時間は paused 中は伸びない。
    pub paused: bool,
    /// ワーカースレッドの致命的エラー(#79: デバイス切断等を停止を待た
    /// ずに UI へ伝える)。読み取っても消費しない — stop 時のエラー
    /// 返却経路はそのまま残す。
    pub error: Option<String>,
}

#[tauri::command]
pub fn capture_status() -> CaptureStatus {
    let guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(s) => {
            let mut shared = s.shared.lock().unwrap_or_else(|e| e.into_inner());
            let elapsed = if s.info.sample_rate > 0 {
                shared.frames as f64 / s.info.sample_rate as f64
            } else {
                0.0
            };
            // 読むたびに減衰させてメーターの「落ち」を作る。
            let level = shared.level;
            shared.level *= 0.7;
            CaptureStatus {
                active: true,
                source: Some(s.info.source.clone()),
                elapsed_seconds: Some(elapsed),
                device_name: Some(s.info.device_name.clone()),
                level: Some(level),
                paused: shared.paused,
                error: shared.error.clone(),
            }
        }
        None => CaptureStatus {
            active: false,
            source: None,
            elapsed_seconds: None,
            device_name: None,
            level: None,
            paused: false,
            error: None,
        },
    }
}

/// 録音の一時停止(#80)。録音中でなければ `CAPTURE_NOT_ACTIVE`。
#[tauri::command]
pub fn capture_pause() -> Result<(), String> {
    let guard = SESSION.lock().map_err(|_| "capture session lock")?;
    let session = guard.as_ref().ok_or("CAPTURE_NOT_ACTIVE")?;
    let mut s = session.shared.lock().unwrap_or_else(|e| e.into_inner());
    s.paused = true;
    Ok(())
}

/// 一時停止した録音の再開(#80)。
#[tauri::command]
pub fn capture_resume() -> Result<(), String> {
    let guard = SESSION.lock().map_err(|_| "capture session lock")?;
    let session = guard.as_ref().ok_or("CAPTURE_NOT_ACTIVE")?;
    let mut s = session.shared.lock().unwrap_or_else(|e| e.into_inner());
    s.paused = false;
    Ok(())
}

/// 録音開始。`source` は `"loopback"` または `"microphone"`。
/// `device_id` は `capture_devices` が返すエンドポイント ID(省略時は
/// 既定デバイス)。`suggested_name` は stop 時の保存ファイル名。
/// すでに録音中なら `Err("CAPTURE_BUSY")`。
#[tauri::command]
pub fn capture_start(
    source: String,
    device_id: Option<String>,
    suggested_name: Option<String>,
) -> Result<CaptureSessionInfo, String> {
    let src = match source.as_str() {
        "loopback" => CaptureSource::Loopback,
        "microphone" | "mic" => CaptureSource::Microphone,
        other => return Err(format!("unknown capture source: {other}")),
    };

    let mut guard = SESSION.lock().map_err(|_| "capture session lock")?;
    if guard.is_some() {
        return Err("CAPTURE_BUSY".to_string());
    }

    let shared = Arc::new(Mutex::new(SharedBuf {
        samples: VecDeque::new(),
        stopping: false,
        paused: false,
        error: None,
        frames: 0,
        silent_frames: 0,
        limit_reached: false,
        level: 0.0,
    }));
    let cancel = Arc::new(AtomicBool::new(false));

    // スレッド内でデバイス情報を確定させるため、先に 1 回同期で掴む。
    // (デバイス列挙自体は速いので UI スレッドで実行してよい。)
    let (device_name, sample_rate, channels) = probe_device(src, device_id.as_deref())?;
    let info = CaptureSessionInfo {
        source: src.canonical_name().to_string(),
        device_name,
        sample_rate,
        channels,
    };

    let shared_t = Arc::clone(&shared);
    let cancel_t = Arc::clone(&cancel);
    let device_id_t = device_id.clone();
    let handle = std::thread::Builder::new()
        .name("hornscribe-capture".into())
        .spawn(move || capture_thread(src, device_id_t, shared_t, cancel_t))
        .map_err(|e| format!("spawn capture thread: {e}"))?;

    *guard = Some(ActiveSession {
        info: CaptureSessionInfo {
            source: src.canonical_name().to_string(),
            device_name: info.device_name.clone(),
            sample_rate,
            channels,
        },
        shared,
        cancel,
        handle,
        suggested_name: suggested_name.unwrap_or_default(),
    });
    Ok(info)
}

/// 録音デバイス一覧(#73: 既定以外を選べるようにする)。
/// ループバックは eRender 側、マイクは eCapture 側を選ぶ。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDeviceList {
    pub loopback: Vec<CaptureDevice>,
    pub microphone: Vec<CaptureDevice>,
}

#[tauri::command]
pub fn capture_devices() -> Result<CaptureDeviceList, String> {
    unsafe {
        let _com = ComInit::new()?;
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("MMDeviceEnumerator: {}", hresult_message(&e)))?;
        Ok(CaptureDeviceList {
            loopback: enum_devices(&enumerator, eRender)?,
            microphone: enum_devices(&enumerator, eCapture)?,
        })
    }
}

fn enum_devices(
    enumerator: &IMMDeviceEnumerator,
    flow: windows::Win32::Media::Audio::EDataFlow,
) -> Result<Vec<CaptureDevice>, String> {
    unsafe {
        let default_id = enumerator
            .GetDefaultAudioEndpoint(flow, eConsole)
            .and_then(|d| d.GetId())
            .ok()
            .and_then(|p| if p.0.is_null() { None } else { p.to_string().ok() });
        let coll = enumerator
            .EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)
            .map_err(|e| format!("EnumAudioEndpoints: {}", hresult_message(&e)))?;
        let count = coll
            .GetCount()
            .map_err(|e| format!("GetCount: {}", hresult_message(&e)))?;
        let mut out = Vec::new();
        for i in 0..count {
            let device = match coll.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let id = device
                .GetId()
                .ok()
                .and_then(|p| if p.0.is_null() { None } else { p.to_string().ok() })
                .unwrap_or_default();
            let name = device_friendly_name(&device)
                .unwrap_or_else(|| "(device)".to_string());
            out.push(CaptureDevice {
                is_default: !id.is_empty() && Some(id.as_str()) == default_id.as_deref(),
                id,
                name,
            });
        }
        Ok(out)
    }
}

/// 録音を止めて WAV を appDataDir/recordings/ に保存し、パスとメタ情報を返す。
#[tauri::command]
pub fn capture_stop(app: tauri::AppHandle) -> Result<CaptureResult, String> {
    let session = {
        let mut guard = SESSION.lock().map_err(|_| "capture session lock")?;
        guard.take().ok_or("CAPTURE_NOT_ACTIVE")?
    };
    // ワーカーに停止を伝えて join。
    {
        let mut s = session.shared.lock().unwrap_or_else(|e| e.into_inner());
        s.stopping = true;
    }
    let _ = session.handle.join();

    let mut s = session.shared.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(err) = s.error.take() {
        return Err(err);
    }

    let channels = session.info.channels as usize;
    let frames = (s.frames as usize).min(s.samples.len() / channels.max(1));
    let samples: Vec<f32> = s
        .samples
        .drain(..)
        .take(frames * channels)
        .collect();
    let wav = encode_wav(&samples, session.info.sample_rate, session.info.channels);
    let path = save_wav(&app, &session.suggested_name, &wav)?;
    let duration_seconds = if session.info.sample_rate > 0 {
        frames as f64 / session.info.sample_rate as f64
    } else {
        0.0
    };
    let silent_ratio = if s.frames > 0 {
        s.silent_frames as f64 / s.frames as f64
    } else {
        1.0
    };
    Ok(CaptureResult {
        path,
        duration_seconds,
        sample_rate: session.info.sample_rate,
        channels: session.info.channels,
        silent_ratio,
        limit_reached: s.limit_reached,
    })
}

/// 録音を中止してデータを捨てる。
#[tauri::command]
pub fn capture_cancel() -> Result<(), String> {
    let session = {
        let mut guard = SESSION.lock().map_err(|_| "capture session lock")?;
        guard.take().ok_or("CAPTURE_NOT_ACTIVE")?
    };
    {
        let mut s = session.shared.lock().unwrap_or_else(|e| e.into_inner());
        s.stopping = true;
    }
    session.cancel.store(true, Ordering::SeqCst);
    let _ = session.handle.join();
    Ok(())
}

/* ------------------------- recordings lifecycle (#78) ----------------------- */

/// `recordings_info` の返り値 — 設定画面の録音管理セクション用。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingsInfo {
    /// appDataDir/recordings/ の絶対パス(表示用)。
    pub dir: String,
    /// 保存済み WAV の件数。
    pub file_count: u32,
    /// 合計バイト数。
    pub total_bytes: u64,
}

fn recordings_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("recordings"))
}

/// 録音フォルダの場所・件数・使用量(#78)。
#[tauri::command]
pub fn recordings_info(app: tauri::AppHandle) -> Result<RecordingsInfo, String> {
    let dir = recordings_dir(&app)?;
    let mut file_count = 0u32;
    let mut total_bytes = 0u64;
    if dir.is_dir() {
        let entries =
            std::fs::read_dir(&dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("wav")
                && path.is_file()
            {
                file_count += 1;
                total_bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    Ok(RecordingsInfo {
        dir: dir.to_string_lossy().into_owned(),
        file_count,
        total_bytes,
    })
}

/// 録音フォルダをエクスプローラーで開く(#78)。フォルダが無ければ作成
/// してから開く(空で開けない方が不親切)。
#[tauri::command]
pub fn open_recordings_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = recordings_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("recordings dir: {e}"))?;
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("explorer {}: {e}", dir.display()))?;
    Ok(())
}

/// 録音フォルダの WAV を全削除し、解放したバイト数を返す(#78)。
/// 録音中は拒否する — 進行中セッションの保存先を消すと stop 時に
/// 失敗するため。
#[tauri::command]
pub fn clear_recordings(app: tauri::AppHandle) -> Result<u64, String> {
    {
        let guard = SESSION.lock().map_err(|_| "capture session lock")?;
        if guard.is_some() {
            return Err("CAPTURE_BUSY".to_string());
        }
    }
    let dir = recordings_dir(&app)?;
    if !dir.is_dir() {
        return Ok(0);
    }
    let mut freed = 0u64;
    let entries =
        std::fs::read_dir(&dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("wav") && path.is_file() {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if std::fs::remove_file(&path).is_ok() {
                freed += size;
            }
        }
    }
    Ok(freed)
}

/// `recordings_list` の1件分 — 設定画面の個別管理用(#78)。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFile {
    /// ファイル名(表示・削除キー)。パスではなく名前だけを往復させる。
    pub name: String,
    /// バイト数。
    pub bytes: u64,
    /// 更新時刻(UNIX秒)。
    pub modified_sec: u64,
}

/// 録音 WAV の一覧(#78)。ファイル名の昇順で返す。
#[tauri::command]
pub fn recordings_list(app: tauri::AppHandle) -> Result<Vec<RecordingFile>, String> {
    let dir = recordings_dir(&app)?;
    let mut files = Vec::new();
    if dir.is_dir() {
        let entries =
            std::fs::read_dir(&dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("wav")
                || !path.is_file()
            {
                continue;
            }
            let meta = entry.metadata().ok();
            let modified = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            files.push(RecordingFile {
                name: entry.file_name().to_string_lossy().into_owned(),
                bytes: meta.map(|m| m.len()).unwrap_or(0),
                modified_sec: modified,
            });
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

/// 録音 WAV を1件削除する(#78)。`name` はファイル名のみ許可 —
/// パス区切りを含む入力は recordings/ 外を指せるので拒否する。
/// 録音中は CAPTURE_BUSY で拒否(全削除と同じガード)。
#[tauri::command]
pub fn delete_recording(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if name.is_empty()
        || name.contains('\\')
        || name.contains('/')
        || name.contains("..")
        || !name.to_lowercase().ends_with(".wav")
    {
        return Err("invalid recording name".to_string());
    }
    {
        let guard = SESSION.lock().map_err(|_| "capture session lock")?;
        if guard.is_some() {
            return Err("CAPTURE_BUSY".to_string());
        }
    }
    let path = recordings_dir(&app)?.join(&name);
    std::fs::remove_file(&path).map_err(|e| format!("delete {name}: {e}"))
}

/// #132: 録音 WAV を managed 領域 appDataDir/sources/ へコピーし、
/// コピー先の絶対パスを返す。プロジェクト保存時に呼び、
/// sourceAudio.originalPath を保持ポリシー対象外のパスに向ける —
/// 録音=一時作業領域、プロジェクト=永続成果物の製品境界。
/// name は delete_recording と同じ bare-name 検証。同名ファイルが
/// 既にある場合、内容が一致すれば再利用し、異なれば -N サフィックスを
/// 付けて衝突を避ける(同一録音の再保存で複製が増えない)。
/// 録音中も許可する: コピーは完成済み WAV の読み取りだけで録音
/// セッションを妨げない。
#[tauri::command]
pub fn copy_recording_to_managed(app: tauri::AppHandle, name: String) -> Result<String, String> {
    if name.is_empty()
        || name.contains('\\')
        || name.contains('/')
        || name.contains("..")
        || !name.to_lowercase().ends_with(".wav")
    {
        return Err("invalid recording name".to_string());
    }
    let src = recordings_dir(&app)?.join(&name);
    let meta = std::fs::metadata(&src).map_err(|e| format!("{name}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {name}"));
    }
    let dir = sources_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("sources dir: {e}"))?;

    // Same-name reuse when bytes match; otherwise find a free -N suffix.
    // Strip the extension case-insensitively (the check above allowed
    // any case) so "TAKE.WAV" still stems to "TAKE".
    let stem = &name[..name.len() - 4];
    let mut candidate = dir.join(&name);
    if candidate.exists() {
        let src_bytes = std::fs::read(&src).map_err(|e| format!("read {name}: {e}"))?;
        let mut slot: Option<std::path::PathBuf> = None;
        for n in 0..100 {
            let c = if n == 0 {
                dir.join(&name)
            } else {
                dir.join(format!("{stem}-{n}.wav"))
            };
            if !c.exists() {
                slot = Some(c);
                break;
            }
            let existing = std::fs::read(&c).map_err(|e| format!("read {:?}: {e}", c))?;
            if existing == src_bytes {
                return Ok(c.to_string_lossy().into_owned());
            }
        }
        candidate = slot.ok_or("no free managed source name")?;
    }
    std::fs::copy(&src, &candidate).map_err(|e| format!("copy {name}: {e}"))?;
    Ok(candidate.to_string_lossy().into_owned())
}

/* ------------------------- managed sources (#147) -------------------------- */

/// appDataDir/sources/ — copy_recording_to_managed の書き出し先。
/// プロジェクトが参照する永続領域で、recordings/ の保持ポリシーは
/// 適用しない(削除はユーザー操作のみ)。
fn sources_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("sources"))
}

/// sources/ の場所・件数・使用量(#147)。recordings_info の sources 版。
#[tauri::command]
pub fn sources_info(app: tauri::AppHandle) -> Result<RecordingsInfo, String> {
    let dir = sources_dir(&app)?;
    let mut file_count = 0u32;
    let mut total_bytes = 0u64;
    if dir.is_dir() {
        let entries =
            std::fs::read_dir(&dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("wav")
                && path.is_file()
            {
                file_count += 1;
                total_bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    Ok(RecordingsInfo {
        dir: dir.to_string_lossy().into_owned(),
        file_count,
        total_bytes,
    })
}

/// sources/ の WAV 一覧(#147)。recordings_list と同じ形・同じ順序。
#[tauri::command]
pub fn sources_list(app: tauri::AppHandle) -> Result<Vec<RecordingFile>, String> {
    let dir = sources_dir(&app)?;
    let mut files = Vec::new();
    if dir.is_dir() {
        let entries =
            std::fs::read_dir(&dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("wav")
                || !path.is_file()
            {
                continue;
            }
            let meta = entry.metadata().ok();
            let modified = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            files.push(RecordingFile {
                name: entry.file_name().to_string_lossy().into_owned(),
                bytes: meta.map(|m| m.len()).unwrap_or(0),
                modified_sec: modified,
            });
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

/// sources/ をエクスプローラーで開く(#147)。
#[tauri::command]
pub fn open_sources_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = sources_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("sources dir: {e}"))?;
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("explorer {}: {e}", dir.display()))?;
    Ok(())
}

/// sources/ の WAV を1件削除する(#147)。bare-name 検証は
/// delete_recording と同じ。録音中でも許可する: sources/ は完成済み
/// WAV のコピー置き場で、録画セッションの保存先ではない。
/// プロジェクトが参照するファイルの削除は UI 側が警告する — ここでは
/// 拒否しない(参照は別プロジェクトの所有物であり、削除権限はユーザー)。
#[tauri::command]
pub fn delete_source(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if name.is_empty()
        || name.contains('\\')
        || name.contains('/')
        || name.contains("..")
        || !name.to_lowercase().ends_with(".wav")
    {
        return Err("invalid source name".to_string());
    }
    let path = sources_dir(&app)?.join(&name);
    std::fs::remove_file(&path).map_err(|e| format!("delete {name}: {e}"))
}

/* ------------------------------- internals -------------------------------- */

/// 既定デバイスの表示名と共有モードフォーマットを掴む。
/// `capture_start` 内の即時フィードバック用(実際のキャプチャ開始は
/// スレッド内でやり直す)。
fn probe_device(
    source: CaptureSource,
    device_id: Option<&str>,
) -> Result<(String, u32, u16), String> {
    unsafe {
        // このスコープだけ COM を初期化する。
        let _com = ComInit::new()?;
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("MMDeviceEnumerator: {}", hresult_message(&e)))?;
        let device: IMMDevice = get_endpoint(&enumerator, source, device_id)
            .map_err(|e| match source {
                CaptureSource::Loopback => format!(
                    "再生デバイスが見つかりません ({})",
                    hresult_message(&e)
                ),
                CaptureSource::Microphone => format!(
                    "マイクが見つかりません ({})",
                    hresult_message(&e)
                ),
            })?;
        let name = device_friendly_name(&device).unwrap_or_else(|| "(device)".to_string());
        let audio: IAudioClient = device
            .Activate::<IAudioClient>(CLSCTX_ALL, None)
            .map_err(|e| format!("IAudioClient: {}", hresult_message(&e)))?;
        let fmt_ptr = audio
            .GetMixFormat()
            .map_err(|e| format!("GetMixFormat: {}", hresult_message(&e)))?;
        if fmt_ptr.is_null() {
            return Err("GetMixFormat returned null".to_string());
        }
        let fmt = &*fmt_ptr;
        let rate = fmt.nSamplesPerSec;
        let ch = fmt.nChannels;
        CoTaskMemFree(Some(fmt_ptr as *const _));
        Ok((name, rate, ch))
    }
}

/// デバイス取得: `device_id` があれば `GetDevice`、なければ既定。
fn get_endpoint(
    enumerator: &IMMDeviceEnumerator,
    source: CaptureSource,
    device_id: Option<&str>,
) -> windows::core::Result<IMMDevice> {
    unsafe {
        match device_id {
            Some(id) if !id.is_empty() => {
                let wide = windows::core::HSTRING::from(id);
                // Param<PCWSTR> は CopyType — 値渡し(& 参照は InterfaceType
                // として解釈されて型エラーになる)。
                enumerator.GetDevice(windows::core::PCWSTR::from_raw(wide.as_ptr()))
            }
            _ => enumerator.GetDefaultAudioEndpoint(source.data_flow(), eConsole),
        }
    }
}

/// COM のスコープ初期化(スレッド毎に必要)。
/// `uninit`: Drop 時に CoUninitialize を呼ぶか。既に STA 初期化済みの
/// スレッドでは呼ばない(カウントが合わない)。
struct ComInit {
    uninit: bool,
}
impl ComInit {
    fn new() -> Result<Self, String> {
        unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_err() {
                // RPC_E_CHANGED_MODE (0x80010106): 既に STA で初期化済み
                // のスレッド(Tauri コマンドスレッド等)。その場合は既存の
                // アパートメントで動くので成功扱いにし、Drop では
                // アンバランスな CoUninitialize を呼ばないよう None を返す。
                if hr.0 == 0x80010106u32 as i32 {
                    return Ok(ComInit { uninit: false });
                }
                return Err(format!("CoInitializeEx: 0x{:08X}", hr.0 as u32));
            }
        }
        Ok(ComInit { uninit: true })
    }
}
impl Drop for ComInit {
    fn drop(&mut self) {
        if self.uninit {
            unsafe { CoUninitialize() }
        }
    }
}

/// `PKEY_Device_FriendlyName` を取る。失敗したら None。
fn device_friendly_name(device: &IMMDevice) -> Option<String> {
    unsafe {
        let store = device
            .OpenPropertyStore(STGM_READ)
            .ok()?;
        let value = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
        let pwstr = PropVariantToStringAlloc(&value).ok()?;
        if pwstr.0.is_null() {
            return None;
        }
        let s = pwstr.to_string().ok()?;
        CoTaskMemFree(Some(pwstr.0 as *const _));
        Some(s)
    }
}

/// 取得ループ本体。`SharedBuf` に f32 サンプルを積み、`stopping`/`cancel`
/// で抜ける。WASAPI 共有モードで 10ms 粒度のイベント駆動取得。
fn capture_thread(
    source: CaptureSource,
    device_id: Option<String>,
    shared: Arc<Mutex<SharedBuf>>,
    cancel: Arc<AtomicBool>,
) {
    if let Err(e) = run_capture(source, device_id.as_deref(), &shared, &cancel) {
        let mut s = shared.lock().unwrap_or_else(|e| e.into_inner());
        s.error = Some(e);
    }
}

fn run_capture(
    source: CaptureSource,
    device_id: Option<&str>,
    shared: &Arc<Mutex<SharedBuf>>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    unsafe {
        let _com = ComInit::new()?;
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("MMDeviceEnumerator: {}", hresult_message(&e)))?;
        let device: IMMDevice = get_endpoint(&enumerator, source, device_id)
            .map_err(|e| format!("audio endpoint: {}", hresult_message(&e)))?;
        let audio: IAudioClient = device
            .Activate::<IAudioClient>(CLSCTX_ALL, None)
            .map_err(|e| format!("IAudioClient activate: {}", hresult_message(&e)))?;
        let fmt_ptr = audio
            .GetMixFormat()
            .map_err(|e| format!("GetMixFormat: {}", hresult_message(&e)))?;
        if fmt_ptr.is_null() {
            return Err("GetMixFormat returned null".to_string());
        }
        // 共有モードはデバイスの mix フォーマットでしか開けない。float32
        // か 16bit PCM を想定し、それ以外は WAVEFORMATEXTENSIBLE の
        // SubFormat を見て判定する。
        let fmt: WAVEFORMATEX = *fmt_ptr;
        let (sample_rate, channels, is_float, bits) = describe_format(&fmt);
        let block_align = fmt.nBlockAlign as usize;

        // 100ms バッファで十分大きく取る。ループバックはイベント駆動不可
        // (AUDCLNT_STREAMFLAGS_LOOPBACK はイベントと併用できない)ので
        // ポーリング sleep に切り替える。
        let buffer_duration_100ns: i64 = 1_000_000; // 100 ms
        let is_loopback = source == CaptureSource::Loopback;
        audio
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                source.stream_flags(),
                buffer_duration_100ns,
                0,
                fmt_ptr,
                None,
            )
            .map_err(|e| format!("IAudioClient::Initialize: {}", hresult_message(&e)))?;
        let capture: IAudioCaptureClient = audio
            .GetService::<IAudioCaptureClient>()
            .map_err(|e| format!("IAudioCaptureClient: {}", hresult_message(&e)))?;
        audio
            .Start()
            .map_err(|e| format!("IAudioClient::Start: {}", hresult_message(&e)))?;

        let max_samples = (sample_rate as usize)
            .saturating_mul(channels)
            .saturating_mul((MAX_SECONDS + MAX_SECONDS_SLACK) as usize);

        // #80 一時停止: クライアント自体を止めてパケットを捨てる。
        // バッファを貯めて後で読む方式にすると「止めていた間の音」が
        // 録音に紛れ込むので、ここでは正直なギャップを選ぶ。
        let mut paused_active = false;
        loop {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            {
                let s = shared.lock().unwrap_or_else(|e| e.into_inner());
                if s.stopping {
                    break;
                }
                if s.paused != paused_active {
                    if s.paused {
                        let _ = audio.Stop();
                    } else {
                        audio
                            .Start()
                            .map_err(|e| {
                                format!(
                                    "IAudioClient::Start (resume): {}",
                                    hresult_message(&e)
                                )
                            })?;
                    }
                    paused_active = s.paused;
                }
            }
            if paused_active {
                std::thread::sleep(std::time::Duration::from_millis(20));
                continue;
            }
            // 取得可能なフレームがあれば全て取り込む。なければ次のポーリングへ。
            let mut next_size = capture
                .GetNextPacketSize()
                .map_err(|e| format!("GetNextPacketSize: {}", hresult_message(&e)))?;
            if next_size == 0 {
                std::thread::sleep(std::time::Duration::from_millis(5));
                continue;
            }
            while next_size > 0 {
                let mut data_ptr: *mut u8 = std::ptr::null_mut();
                let mut num_frames: u32 = 0;
                let mut flags: u32 = 0;
                let mut pos: u64 = 0;
                let mut qpc: u64 = 0;
                capture
                    .GetBuffer(
                        &mut data_ptr,
                        &mut num_frames,
                        &mut flags,
                        Some(&mut pos as *mut u64),
                        Some(&mut qpc as *mut u64),
                    )
                    .map_err(|e| format!("GetBuffer: {}", hresult_message(&e)))?;
                let silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                if num_frames > 0 {
                    let byte_len = num_frames as usize * block_align;
                    let mut s = shared.lock().unwrap_or_else(|e| e.into_inner());
                    // 上限超過は古い方から捨てない(録音冒頭は大事)。
                    // 追記を止めて録音を打ち切る — UI 側は経過時間が
                    // MAX_SECONDS で止まることで暗に上限を知れる。
                    if s.samples.len() >= max_samples {
                        s.stopping = true;
                        s.limit_reached = true;
                    } else {
                        if silent {
                            s.samples.extend(std::iter::repeat(0.0f32).take(num_frames as usize * channels));
                            s.silent_frames += num_frames as u64;
                        } else {
                            let src = std::slice::from_raw_parts(data_ptr, byte_len);
                            decode_into_f32(src, &fmt, is_float, bits, channels, &mut s.samples);
                            // -60dBFS 判定 + パケットのピークを同時に採る。
                            let mut silent_count = 0usize;
                            let mut packet_peak = 0.0f32;
                            for i in 0..(num_frames as usize) {
                                let mut peak = 0.0f32;
                                for c in 0..channels {
                                    let v = s.samples
                                        .get(s.samples.len() - (num_frames as usize * channels) + i * channels + c)
                                        .copied()
                                        .unwrap_or(0.0)
                                        .abs();
                                    if v > peak { peak = v; }
                                }
                                if peak < 0.001 { silent_count += 1; }
                                if peak > packet_peak { packet_peak = peak; }
                            }
                            s.silent_frames += silent_count as u64;
                            // レベルメーター(#71): パケットピークを採用し、
                            // 減衰は status ポーリング側で行う。
                            if packet_peak > s.level { s.level = packet_peak; }
                        }
                    }
                    s.frames += num_frames as u64;
                }
                capture
                    .ReleaseBuffer(num_frames)
                    .map_err(|e| format!("ReleaseBuffer: {}", hresult_message(&e)))?;
                next_size = capture
                    .GetNextPacketSize()
                    .map_err(|e| format!("GetNextPacketSize: {}", hresult_message(&e)))?;
            }
            if !is_loopback {
                // マイクも同じポーリングで十分(イベント駆動にすると
                // 別途 HANDLE を作る必要があり、このコード量では割に合わない)。
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        }
        let _ = audio.Stop();
        CoTaskMemFree(Some(fmt_ptr as *const _));
    }
    Ok(())
}

/// WAVEFORMATEX から (rate, channels, is_float, bits) を取る。
/// WAVEFORMATEXTENSIBLE の SubFormat も見る。
fn describe_format(fmt: &WAVEFORMATEX) -> (u32, usize, bool, u16) {
    let rate = fmt.nSamplesPerSec;
    let channels = fmt.nChannels as usize;
    let bits = fmt.wBitsPerSample;
    let tag = fmt.wFormatTag;
    // WAVE_FORMAT_IEEE_FLOAT = 3
    if tag == 3 {
        return (rate, channels, true, bits);
    }
    // WAVE_FORMAT_EXTENSIBLE = 0xFFFE
    if tag == 0xFFFE {
        unsafe {
            let ext = &*(fmt as *const WAVEFORMATEX as *const WAVEFORMATEXTENSIBLE);
            // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = {00000003-0000-0010-8000-00aa00389b71}
            // windows-core 0.61 の GUID フィールドは snake_case。
            if ext.SubFormat.data1 == 3 {
                return (rate, channels, true, bits);
            }
        }
    }
    (rate, channels, false, bits)
}

/// PCM バイト列を f32 (インターリーブ) にデコードして `out` に積む。
fn decode_into_f32(
    bytes: &[u8],
    fmt: &WAVEFORMATEX,
    is_float: bool,
    bits: u16,
    channels: usize,
    out: &mut VecDeque<f32>,
) {
    if is_float {
        // f32
        let stride = channels * 4;
        for frame in bytes.chunks_exact(stride) {
            for c in 0..channels {
                let off = c * 4;
                let v = f32::from_le_bytes([
                    frame[off],
                    frame[off + 1],
                    frame[off + 2],
                    frame[off + 3],
                ]);
                out.push_back(v);
            }
        }
        return;
    }
    match bits {
        16 => {
            let stride = channels * 2;
            for frame in bytes.chunks_exact(stride) {
                for c in 0..channels {
                    let off = c * 2;
                    let v = i16::from_le_bytes([frame[off], frame[off + 1]]) as f32 / 32768.0;
                    out.push_back(v);
                }
            }
        }
        24 => {
            let stride = channels * 3;
            for frame in bytes.chunks_exact(stride) {
                for c in 0..channels {
                    let off = c * 3;
                    let v = ((frame[off + 2] as i32) << 16)
                        | ((frame[off + 1] as i32) << 8)
                        | (frame[off] as i32);
                    // sign extend
                    let v = if v & 0x800000 != 0 { v | !0xFFFFFF } else { v };
                    out.push_back(v as f32 / 8388608.0);
                }
            }
        }
        32 => {
            // 32-bit int (mix 形式ではまれ。WAVEFORMATEXTENSIBLE の int32
            // SubFormat を拾う)
            let stride = channels * 4;
            for frame in bytes.chunks_exact(stride) {
                for c in 0..channels {
                    let off = c * 4;
                    let v = i32::from_le_bytes([
                        frame[off],
                        frame[off + 1],
                        frame[off + 2],
                        frame[off + 3],
                    ]) as f32
                        / 2147483648.0;
                    out.push_back(v);
                }
            }
        }
        _ => {
            // 未対応フォーマット — 無音で埋める(デコードを黙って落とすより
            // 「無音だった」方がユーザーには正直)。
            let frames = bytes.len() / fmt.nBlockAlign as usize;
            out.extend(std::iter::repeat(0.0f32).take(frames * channels));
        }
    }
}

/// f32 インターリーブサンプル → 16bit PCM WAV。
/// CI/テストで確実に通るよう、ここは pure-Rust で書く。
fn encode_wav(samples: &[f32], sample_rate: u32, channels: u16) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    let byte_rate = sample_rate * channels as u32 * 2;
    let block_align = channels * 2;
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &v in samples {
        // 32768 スケールで -1.0 がフルスケール -32768 になるよう量子化し、
        // 正側は 32767 にクランプする(PCM16 の標準的な写像)。
        let s = ((v.clamp(-1.0, 1.0) * 32768.0).round() as i32)
            .clamp(i16::MIN as i32, i16::MAX as i32) as i16;
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// WAV bytes を appDataDir/recordings/ に書き出して絶対パスを返す。
/// `suggested_name` は UI 提示名と同じもの(サニタイズして .wav を強制)。
/// 衝突時は末尾に連番を付ける。
fn save_wav(
    app: &tauri::AppHandle,
    suggested_name: &str,
    wav: &[u8],
) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| format!("recordings dir: {e}"))?;
    // ファイル名は UI 由来だが、パス要素として安全な文字だけに丸める。
    let stem: String = suggested_name
        .trim_end_matches(".wav")
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let stem = if stem.trim().is_empty() {
        "recording".to_string()
    } else {
        stem
    };
    let mut candidate = dir.join(format!("{stem}.wav"));
    for n in 1..1000u32 {
        if !candidate.exists() { break; }
        candidate = dir.join(format!("{stem}_{n}.wav"));
    }
    std::fs::write(&candidate, wav)
        .map_err(|e| format!("write {}: {e}", candidate.display()))?;
    Ok(candidate.to_string_lossy().into_owned())
}

/* --------------------------------- tests ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    /// WAV ヘッダと末尾が一致するか(エンコードの最小契約)。
    #[test]
    fn wav_header_roundtrip() {
        let samples = [0.0f32, 0.5, -0.5, 1.0];
        let wav = encode_wav(&samples, 48_000, 2);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u32::from_le_bytes(wav[16..20].try_into().unwrap()), 16);
        assert_eq!(u16::from_le_bytes(wav[20..22].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 48_000);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 8);
        // samples are 16-bit LE
        assert_eq!(i16::from_le_bytes(wav[44..46].try_into().unwrap()), 0);
        assert_eq!(i16::from_le_bytes(wav[46..48].try_into().unwrap()), 16384);
        assert_eq!(i16::from_le_bytes(wav[48..50].try_into().unwrap()), -16384);
        assert_eq!(i16::from_le_bytes(wav[50..52].try_into().unwrap()), 32767);
    }

    /// デコード境界: f32 入力はクリップされる。
    #[test]
    fn wav_clamps() {
        let wav = encode_wav(&[1.5f32, -2.0], 44_100, 1);
        assert_eq!(i16::from_le_bytes(wav[44..46].try_into().unwrap()), 32767);
        assert_eq!(i16::from_le_bytes(wav[46..48].try_into().unwrap()), -32768);
    }
}
