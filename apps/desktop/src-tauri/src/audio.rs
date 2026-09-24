//! #230: native audio ingest — probe metadata/peaks/hash in Rust so the
//! webview never decodes (or even copies) the whole file, and stream
//! playback to the <audio> element through a token-scoped `media` URI
//! scheme with HTTP Range support.
//!
//! Replaces the old pipeline (read all bytes -> IPC -> Blob ->
//! decodeAudioData -> full-PCM peaks -> hash another copy) for
//! path-backed sources. `read_audio_bytes` stays for browser-held
//! blobs and as the frontend fallback when the probe is unavailable.
//!
//! Security: the `media` scheme serves only paths registered by
//! `audio_probe` (extension allowlist + size cap, same as
//! `read_audio_bytes`) — the token URL alone cannot read arbitrary
//! files, and the source is only ever read.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// Same allowlist as `read_audio_bytes` in lib.rs.
const AUDIO_EXTENSIONS: [&str; 5] = ["wav", "mp3", "flac", "m4a", "ogg"];
/// Same cap as `read_audio_bytes` — far above any realistic take.
const MAX_AUDIO_BYTES: u64 = 512 * 1024 * 1024;
/// Waveform strip resolution (matches computePeaks in runtimePorts.ts).
const PEAK_BUCKETS: usize = 600;
/// ffmpeg decode target — fixed so duration = frames / rate exactly.
const FFMPEG_RATE: u32 = 48_000;
const FFMPEG_CHANNELS: u16 = 2;
/// Sub-peak granularity for ffmpeg streams (total frames unknown):
/// one local max per 8192-frame interval, downsampled at the end —
/// ~1,300 subs for 10 min, so memory stays trivial.
const SUBPEAK_FRAMES: u64 = 8_192;
/// Cap on simultaneously servable media tokens.
const MAX_MEDIA_TOKENS: usize = 32;

struct MediaEntry {
    path: PathBuf,
    mime: &'static str,
}

fn media_registry() -> &'static Mutex<HashMap<String, MediaEntry>> {
    static REG: OnceLock<Mutex<HashMap<String, MediaEntry>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register a servable path under a content-derived token (dedup-safe:
/// identical bytes map to the same token and simply re-register).
fn register_media(path: PathBuf, mime: &'static str, token: &str) {
    if let Ok(mut reg) = media_registry().lock() {
        if reg.len() >= MAX_MEDIA_TOKENS && !reg.contains_key(token) {
            // Evict an arbitrary older entry — 32 live sources is far
            // beyond the single-document app's real usage.
            if let Some(k) = reg.keys().next().cloned() {
                reg.remove(&k);
            }
        }
        reg.insert(token.to_string(), MediaEntry { path, mime });
    }
}

/// URL the webview uses for <audio> playback. Custom schemes resolve to
/// `http://<scheme>.localhost` under WebView2 (Windows).
fn media_url(token: &str) -> String {
    if cfg!(windows) {
        format!("http://media.localhost/{token}")
    } else {
        format!("media://localhost/{token}")
    }
}

/// `audio_probe` result — everything AUDIO_READY needs without the
/// file's bytes ever entering the webview.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProbeResult {
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub size_bytes: u64,
    /// SHA-256 of the source bytes — same contract as the frontend
    /// sha256Hex and project model hash_file_sha256.
    pub content_hash: String,
    /// Normalized 0..1 peaks, PEAK_BUCKETS entries.
    pub peaks: Vec<f32>,
    /// media:// playback URL (token-scoped; Range-capable).
    pub playback_url: String,
}

/// Probe a path-backed audio source natively (#230).
///
/// Streams a SHA-256, parses WAV metadata + peaks in Rust, and falls
/// back to ffmpeg (decode to s16le, streamed) for compressed formats —
/// so the advertised MP3/FLAC/M4A/OGG list actually opens everywhere
/// ffmpeg is present instead of depending on WebView2 codec luck.
/// FLAC playback gets a normalized WAV cache (WebView2 codec support
/// is not guaranteed); MP3/M4A/OGG stream the original file.
#[tauri::command]
pub fn audio_probe(app: tauri::AppHandle, path: String) -> Result<AudioProbeResult, String> {
    let ext = Path::new(&path)
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
    let content_hash = sha256_file(&path)?;

    let probed = if ext == "wav" {
        match probe_wav(&path) {
            Ok(p) => p,
            // Odd-but-valid WAVs (extensible, float, unusual chunking)
            // still open via the ffmpeg fallback.
            Err(e) => probe_ffmpeg(&path).map_err(|_| e)?,
        }
    } else {
        probe_ffmpeg(&path)?
    };

    // FLAC: WebView2 codec support is not guaranteed — normalize once
    // into a content-keyed WAV cache so playback actually works.
    let mut play_path = PathBuf::from(&path);
    let mut mime = mime_of(&ext);
    if ext == "flac" {
        if let Some(wav) = flac_to_wav(&app, &path, &content_hash) {
            play_path = wav;
            mime = "audio/wav";
        }
        // If ffmpeg vanished between probe and transcode, keep the
        // original — the element may still play it.
    }

    let token = content_hash[..32].to_string();
    register_media(play_path, mime, &token);
    Ok(AudioProbeResult {
        duration_seconds: probed.duration_seconds,
        sample_rate: probed.sample_rate,
        channels: probed.channels,
        size_bytes: meta.len(),
        content_hash,
        peaks: probed.peaks,
        playback_url: media_url(&token),
    })
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

/// Streaming SHA-256 — mirrors hash_file_sha256 in the project schema.
fn sha256_file(path: &str) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("read {path}: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

struct Probed {
    duration_seconds: f64,
    sample_rate: u32,
    channels: u16,
    peaks: Vec<f32>,
}

/* ------------------------------- WAV probe ------------------------------- */

fn probe_wav(path: &str) -> Result<Probed, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut riff = [0u8; 12];
    f.read_exact(&mut riff).map_err(|e| format!("wav header: {e}"))?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".to_string());
    }
    let mut fmt: Option<(u16, u16, u32, u16, u16)> = None; // tag,ch,rate,bits,align
    let mut data: Option<(u64, u64)> = None; // offset,size
    let mut hdr = [0u8; 8];
    loop {
        let n = f.read(&mut hdr).map_err(|e| format!("wav chunks: {e}"))?;
        if n < 8 {
            break;
        }
        let id = &hdr[0..4];
        let size = u32::from_le_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]) as u64;
        let mut consumed = 0u64;
        if id == b"fmt " {
            let mut buf = [0u8; 40];
            let take = (size.min(40)) as usize;
            f.read_exact(&mut buf[..take])
                .map_err(|e| format!("wav fmt: {e}"))?;
            consumed = take as u64;
            let tag = u16::from_le_bytes([buf[0], buf[1]]);
            let mut channels = u16::from_le_bytes([buf[2], buf[3]]);
            let rate = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
            let align = u16::from_le_bytes([buf[12], buf[13]]);
            let mut bits = u16::from_le_bytes([buf[14], buf[15]]);
            let mut tag = tag;
            if tag == 0xFFFE && size >= 40 && take >= 40 {
                // WAVE_FORMAT_EXTENSIBLE: real tag is the first u16 of
                // the SubFormat GUID, real depth sits in bits[22..24].
                tag = u16::from_le_bytes([buf[24], buf[25]]);
                let valid = u16::from_le_bytes([buf[18], buf[19]]);
                if valid > 0 {
                    bits = valid;
                }
                let ch_mask = u32::from_le_bytes([buf[20], buf[21], buf[22], buf[23]]);
                if ch_mask.count_ones() > 0 {
                    channels = ch_mask.count_ones() as u16;
                }
            }
            fmt = Some((tag, channels, rate, bits, align));
        } else if id == b"data" && data.is_none() {
            data = Some((f.stream_position().map_err(|e| e.to_string())?, size));
        }
        // Chunks are word-aligned; skip to the next header.
        let skip = (size - consumed) + (size & 1);
        if f.seek(SeekFrom::Current(skip as i64)).is_err() {
            break;
        }
    }
    let (tag, channels, rate, bits, align) = fmt.ok_or("wav: no fmt chunk")?;
    let (data_off, data_size) = data.ok_or("wav: no data chunk")?;
    if !matches!(tag, 0x0001 | 0x0003) || rate == 0 || channels == 0 || align == 0 {
        return Err(format!("wav: unsupported format tag {tag:#x}"));
    }
    let align = align.max(1) as u64;
    let total_frames = data_size / align;
    let peaks = wav_peaks(&mut f, data_off, data_size, tag, bits, align, total_frames)?;
    Ok(Probed {
        duration_seconds: total_frames as f64 / rate as f64,
        sample_rate: rate,
        channels,
        peaks,
    })
}

/// Stream the data chunk once; each output bucket takes the max |sample|
/// of its frame range (same contract as computePeaks).
fn wav_peaks(
    f: &mut std::fs::File,
    data_off: u64,
    data_size: u64,
    tag: u16,
    bits: u16,
    align: u64,
    total_frames: u64,
) -> Result<Vec<f32>, String> {
    let mut peaks = vec![0f32; PEAK_BUCKETS];
    if total_frames == 0 {
        return Ok(peaks);
    }
    f.seek(SeekFrom::Start(data_off)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 20];
    let mut carry: Vec<u8> = Vec::with_capacity(align as usize);
    let mut frame_idx = 0u64;
    let mut consumed = 0u64;
    while consumed < data_size {
        let want = (data_size - consumed).min(buf.len() as u64) as usize;
        let n = f.read(&mut buf[..want]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        consumed += n as u64;
        carry.extend_from_slice(&buf[..n]);
        let align_us = align as usize;
        let frames_here = carry.len() / align_us;
        for i in 0..frames_here {
            let frame = &carry[i * align_us..(i + 1) * align_us];
            let mut m = 0f32;
            for ch in frame.chunks_exact((bits / 8).max(1) as usize) {
                let v = sample_value(ch, tag, bits);
                if v > m {
                    m = v;
                }
            }
            let bucket = ((frame_idx * PEAK_BUCKETS as u64) / total_frames) as usize;
            let bucket = bucket.min(PEAK_BUCKETS - 1);
            if m > peaks[bucket] {
                peaks[bucket] = m;
            }
            frame_idx += 1;
        }
        carry.drain(..frames_here * align_us);
    }
    Ok(peaks)
}

/// |sample| normalized to 0..1 for PCM int (tag 1) and IEEE float (tag 3).
fn sample_value(bytes: &[u8], tag: u16, bits: u16) -> f32 {
    match (tag, bits) {
        (0x0001, 8) => (bytes[0] as f32 - 128.0).abs() / 128.0,
        (0x0001, 16) => {
            (i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0).abs()
        }
        (0x0001, 24) => {
            let v = (bytes[0] as i32) | ((bytes[1] as i32) << 8) | ((bytes[2] as i32) << 16);
            let v = if v & 0x800000 != 0 { v | !0xFFFFFF } else { v };
            (v as f32 / 8_388_608.0).abs()
        }
        (0x0001, 32) => {
            (i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32
                / 2_147_483_648.0)
                .abs()
        }
        (0x0003, 32) => {
            f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]).abs()
        }
        (0x0003, 64) => {
            f64::from_le_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3],
                bytes[4], bytes[5], bytes[6], bytes[7],
            ])
            .abs() as f32
        }
        _ => 0.0,
    }
}

/* ------------------------------ ffmpeg probe ----------------------------- */

fn find_ffmpeg() -> Option<String> {
    let ok = std::process::Command::new("where")
        .arg("ffmpeg")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    ok.then(|| "ffmpeg".to_string())
}

/// Decode any ffmpeg-supported file to s16le stereo 48 kHz on stdout,
/// streamed — peaks/duration come from the decoded frames themselves,
/// the source sample rate is parsed from stderr's Stream line.
fn probe_ffmpeg(path: &str) -> Result<Probed, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found")?;
    let mut child = std::process::Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-nostats",
            "-i",
            path,
            "-vn",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-f",
            "s16le",
            "-",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg spawn: {e}"))?;

    // stderr is drained on its own thread so ffmpeg never blocks on a
    // full pipe while we consume stdout.
    let mut stderr = child.stderr.take().ok_or("ffmpeg stderr")?;
    let stderr_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let mut stdout = child.stdout.take().ok_or("ffmpeg stdout")?;
    let mut sub_peaks: Vec<f32> = Vec::new();
    let mut local_max = 0f32;
    let mut local_frames = 0u64;
    let mut frames = 0u64;
    let mut buf = vec![0u8; 1 << 20];
    let mut carry: Vec<u8> = Vec::with_capacity(4);
    loop {
        let n = stdout.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        carry.extend_from_slice(&buf[..n]);
        let frames_here = carry.len() / 4;
        for i in 0..frames_here {
            let base = i * 4;
            let l = i16::from_le_bytes([carry[base], carry[base + 1]]);
            let r = i16::from_le_bytes([carry[base + 2], carry[base + 3]]);
            let m = (l as i32).abs().max((r as i32).abs()) as f32 / 32768.0;
            if m > local_max {
                local_max = m;
            }
            local_frames += 1;
            if local_frames >= SUBPEAK_FRAMES {
                sub_peaks.push(local_max);
                local_max = 0.0;
                local_frames = 0;
            }
        }
        carry.drain(..frames_here * 4);
        frames += frames_here as u64;
    }
    if local_frames > 0 {
        sub_peaks.push(local_max);
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr_text = stderr_thread.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("ffmpeg decode failed: {status}"));
    }
    let (src_rate, src_channels) = parse_stream_info(&stderr_text);
    Ok(Probed {
        duration_seconds: frames as f64 / FFMPEG_RATE as f64,
        sample_rate: src_rate.unwrap_or(FFMPEG_RATE),
        channels: src_channels.unwrap_or(FFMPEG_CHANNELS),
        peaks: downsample_peaks(&sub_peaks),
    })
}

/// `Stream #0:0: Audio: flac, 44100 Hz, stereo` → (rate, channels).
fn parse_stream_info(stderr: &str) -> (Option<u32>, Option<u16>) {
    for line in stderr.lines() {
        let Some(pos) = line.find("Audio:") else {
            continue;
        };
        let rest = &line[pos + 6..];
        let rate = rest
            .split(',')
            .find_map(|p| p.trim().strip_suffix(" Hz"))
            .and_then(|s| s.trim().parse::<u32>().ok());
        let ch_txt = rest.split(',').nth(2).map(|s| s.trim()).unwrap_or("");
        let channels = match ch_txt {
            "mono" => Some(1),
            "stereo" => Some(2),
            _ => None,
        };
        return (rate, channels);
    }
    (None, None)
}

/// Collapse arbitrary-length sub-peak maxima into PEAK_BUCKETS entries.
fn downsample_peaks(sub: &[f32]) -> Vec<f32> {
    let mut out = vec![0f32; PEAK_BUCKETS];
    if sub.is_empty() {
        return out;
    }
    for (i, &v) in sub.iter().enumerate() {
        let b = (i * PEAK_BUCKETS) / sub.len();
        let b = b.min(PEAK_BUCKETS - 1);
        if v > out[b] {
            out[b] = v;
        }
    }
    out
}

/// FLAC → normalized WAV cache under appDataDir/cache/, keyed by content
/// hash so re-probing the same file is free.
fn flac_to_wav(app: &tauri::AppHandle, path: &str, content_hash: &str) -> Option<PathBuf> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .ok()?
        .join("cache");
    std::fs::create_dir_all(&dir).ok()?;
    let out = dir.join(format!("{}.wav", &content_hash[..16]));
    if out.is_file() {
        return Some(out);
    }
    let tmp = dir.join(format!("{}.part.wav", &content_hash[..16]));
    let status = std::process::Command::new(find_ffmpeg()?)
        .args([
            "-y",
            "-v",
            "error",
            "-i",
            path,
            "-vn",
            tmp.to_str()?,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()?;
    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return None;
    }
    std::fs::rename(&tmp, &out).ok().map(|_| out)
}

/* --------------------------- media:// streaming -------------------------- */

enum RangeReq {
    Full,
    Partial(u64, u64), // inclusive
    Invalid,
}

fn parse_range(header: Option<&str>, len: u64) -> RangeReq {
    let Some(h) = header else {
        return RangeReq::Full;
    };
    let Some(spec) = h.strip_prefix("bytes=") else {
        return RangeReq::Full;
    };
    let spec = spec.trim();
    if len == 0 {
        return RangeReq::Invalid;
    }
    if let Some(suf) = spec.strip_prefix('-') {
        let n: u64 = suf.parse().unwrap_or(0);
        if n == 0 {
            return RangeReq::Invalid;
        }
        let n = n.min(len);
        return RangeReq::Partial(len - n, len - 1);
    }
    let mut parts = spec.splitn(2, '-');
    let a = parts.next().unwrap_or("");
    let b = parts.next().unwrap_or("");
    let start: u64 = match a.parse() {
        Ok(v) => v,
        Err(_) => return RangeReq::Invalid,
    };
    if start >= len {
        return RangeReq::Invalid;
    }
    let end = if b.is_empty() {
        len - 1
    } else {
        b.parse::<u64>().unwrap_or(len - 1).min(len - 1)
    };
    if end < start {
        return RangeReq::Invalid;
    }
    RangeReq::Partial(start, end)
}

fn serve_media(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let token = request.uri().path().trim_start_matches('/');
    let entry = media_registry()
        .lock()
        .ok()
        .and_then(|reg| reg.get(token).map(|e| (e.path.clone(), e.mime)));
    let Some((path, mime)) = entry else {
        return tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap();
    };
    let Ok(mut f) = std::fs::File::open(&path) else {
        return tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let range = request
        .headers()
        .get("range")
        .and_then(|v| v.to_str().ok());
    match parse_range(range, len) {
        RangeReq::Invalid => tauri::http::Response::builder()
            .status(416)
            .header("Content-Range", format!("bytes */{len}"))
            .body(Vec::new())
            .unwrap(),
        RangeReq::Partial(start, end) => {
            let take = (end - start + 1) as usize;
            let mut buf = vec![0u8; take];
            let ok = f
                .seek(SeekFrom::Start(start))
                .and_then(|_| f.read_exact(&mut buf));
            if ok.is_err() {
                return tauri::http::Response::builder()
                    .status(416)
                    .body(Vec::new())
                    .unwrap();
            }
            tauri::http::Response::builder()
                .status(206)
                .header("Content-Type", mime)
                .header("Accept-Ranges", "bytes")
                .header("Content-Range", format!("bytes {start}-{end}/{len}"))
                .header("Content-Length", take.to_string())
                .body(buf)
                .unwrap()
        }
        RangeReq::Full => {
            // Media elements always send Range; a plain GET still gets
            // a correct (if heavier) full response.
            let mut buf = Vec::new();
            let _ = f.read_to_end(&mut buf);
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Accept-Ranges", "bytes")
                .header("Content-Length", buf.len().to_string())
                .body(buf)
                .unwrap()
        }
    }
}

/// `media` URI scheme handler — resolves the token to a registered path
/// and serves it on a worker thread (async variant so file I/O never
/// blocks the webview).
pub fn media_scheme_handler<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    std::thread::spawn(move || {
        responder.respond(serve_media(&request));
    });
}
