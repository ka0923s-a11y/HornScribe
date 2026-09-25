/**
 * Settings persistence (UI-060; GUI_UX_SPEC §18/§26).
 *
 * User-facing settings live in one localStorage record (mirroring the
 * existing `hornscribe.theme` / layout persistence — best-effort, never
 * crashes when storage is unavailable or holds stale/foreign data).
 * Only known keys are merged back and every value is re-validated, so a
 * corrupt or newer-version blob degrades to defaults field by field.
 *
 * NO language setting exists — the UI is Japanese-only by contract.
 */

import { useCallback, useMemo, useState } from "react";

import { EXPORT_FORMAT_IDS, type ExportFormatId } from "../export/types";

const STORAGE_KEY = "hornscribe.settings";

/** The §18 categories in display order (録音 sits between 再生 and 採譜). */
export const SETTINGS_CATEGORIES = [
  "appearance",
  "playback",
  "recordings",
  "transcription",
  "score",
  "export",
  "tools",
  "advanced",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export type TempoMode = "auto" | "manual";
export type MeterSetting =
  | "auto"
  | "4/4"
  | "3/4"
  | "6/8"
  | "2/4"
  | "5/4"
  | "7/8"
  | "9/8"
  | "12/8";
export type MinDurationSetting = "eighth" | "sixteenth" | "thirtySecond";
export type ScoreViewMode = "continuous" | "page";
export type BackendSetting = "auto" | "basicPitch" | "pyin";

export interface AppSettings {
  /** 再生 → 標準再生速度 (0.5–2.0). */
  readonly playbackRate: number;
  /** 再生 → 戻る/進む秒数. */
  readonly skipSeconds: number;
  /** 再生 → 再生位置を追従. */
  readonly followPlayback: boolean;
  /** 採譜 → テンポ auto/manual + BPM value. */
  readonly tempoMode: TempoMode;
  readonly bpm: number;
  /** 採譜 → 拍子. */
  readonly meter: MeterSetting;
  /** 採譜 → 最小音価. */
  readonly minDuration: MinDurationSetting;
  /** 採譜 → 三連符を使う. */
  readonly triplets: boolean;
  /** 楽譜 → 初期表示. */
  readonly scoreInitialView: ScoreViewMode;
  /** 書き出し → 既定の保存先 ("" = choose at export time). */
  readonly defaultExportDir: string;
  /** 書き出し → MuseScoreの場所 ("" = auto-detect). */
  readonly museScorePath: string;
  /** ツール → FFmpegの場所 ("" = auto-detect). */
  readonly ffmpegPath: string;
  /** 詳細設定 → 採譜エンジン. */
  readonly backend: BackendSetting;
  /** 録音 → 自動削除の保持日数 (0 = 削除しない). */
  readonly recordingsRetentionDays: number;
  /** 書き出し → 前回選んだ形式 (#377 — re-export keeps the last set). */
  readonly exportFormats: Record<ExportFormatId, boolean>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  playbackRate: 1,
  skipSeconds: 5,
  followPlayback: true,
  tempoMode: "auto",
  bpm: 120,
  meter: "auto",
  minDuration: "sixteenth",
  triplets: true,
  scoreInitialView: "continuous",
  defaultExportDir: "",
  museScorePath: "",
  ffmpegPath: "",
  backend: "auto",
  recordingsRetentionDays: 0,
  // #377: the first-run default is every format on; the dialog then
  // persists whatever the user last picked.
  // #357: source audio stays opt-in — a normal score export must
  // not silently bundle a potentially-huge copyrighted binary.
  exportFormats: Object.fromEntries(
    EXPORT_FORMAT_IDS.map((id) => [id, id !== "sourceAudio"]),
  ) as Record<ExportFormatId, boolean>,
};

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const METERS: readonly MeterSetting[] = [
  "auto",
  "4/4",
  "3/4",
  "6/8",
  "2/4",
  "5/4",
  "7/8",
  "9/8",
  "12/8",
];
const MIN_DURATIONS: readonly MinDurationSetting[] = [
  "eighth",
  "sixteenth",
  "thirtySecond",
];
const VIEWS: readonly ScoreViewMode[] = ["continuous", "page"];
const BACKENDS: readonly BackendSetting[] = ["auto", "basicPitch", "pyin"];

function num(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
    ? v
    : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function oneOf<T extends string>(v: unknown, list: readonly T[]): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v)
    ? (v as T)
    : null;
}

/** Parse + validate the stored blob; unknown/invalid fields get defaults. */
export function parseSettings(raw: string | null): AppSettings {
  if (!raw) return DEFAULT_SETTINGS;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_SETTINGS;
    o = parsed as Record<string, unknown>;
  } catch {
    return DEFAULT_SETTINGS;
  }
  const d = DEFAULT_SETTINGS;
  return {
    playbackRate: num(o.playbackRate, 0.25, 4) ?? d.playbackRate,
    skipSeconds: num(o.skipSeconds, 1, 60) ?? d.skipSeconds,
    followPlayback: bool(o.followPlayback) ?? d.followPlayback,
    tempoMode: oneOf(o.tempoMode, ["auto", "manual"]) ?? d.tempoMode,
    bpm: num(o.bpm, 30, 300) ?? d.bpm,
    meter: oneOf(o.meter, METERS) ?? d.meter,
    minDuration: oneOf(o.minDuration, MIN_DURATIONS) ?? d.minDuration,
    triplets: bool(o.triplets) ?? d.triplets,
    scoreInitialView: oneOf(o.scoreInitialView, VIEWS) ?? d.scoreInitialView,
    defaultExportDir: str(o.defaultExportDir) ?? d.defaultExportDir,
    museScorePath: str(o.museScorePath) ?? d.museScorePath,
    ffmpegPath: str(o.ffmpegPath) ?? d.ffmpegPath,
    backend: oneOf(o.backend, BACKENDS) ?? d.backend,
    recordingsRetentionDays:
      num(o.recordingsRetentionDays, 0, 3650) ?? d.recordingsRetentionDays,
    // #377: per-format booleans — unknown ids are dropped, missing
    // ones fall back to the default so a stale blob never unchecks
    // a format the user never saw.
    exportFormats: (() => {
      const raw = o.exportFormats;
      const out = { ...d.exportFormats };
      if (raw && typeof raw === "object") {
        for (const id of EXPORT_FORMAT_IDS) {
          const v = (raw as Record<string, unknown>)[id];
          if (typeof v === "boolean") out[id] = v;
        }
      }
      return out;
    })(),
  };
}

export function loadSettings(): AppSettings {
  try {
    return parseSettings(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* persistence is best-effort — the session keeps working */
  }
}

/** Valid playback-rate options surfaced in 設定 → 再生. */
export function playbackRateOptions(): readonly number[] {
  return RATES;
}

/**
 * React binding: current settings + a merge-style updater that persists
 * immediately (the theme switcher sets the precedent — changes apply at
 * once, no save button).
 */
export function useAppSettings(): {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
} {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);
  return useMemo(() => ({ settings, update }), [settings, update]);
}
