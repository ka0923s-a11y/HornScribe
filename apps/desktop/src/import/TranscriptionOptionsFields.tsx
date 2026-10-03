/**
 * #55: 採譜オプションのフィールド群 — AUDIO_READY の popover と
 * スコア画面の 採譜オプション dialog で共有する。フィールドの並び・
 * 条件付き表示(manual tempo / voices cap / 範囲入力)はここが単一の
 * 情報源で、両 surface は options + durationSec を渡すだけ。
 */
import { Checkbox } from "@fluentui/react-components";
import { ja } from "../strings/ja";
import { HsNumericField } from "../components/primitives/NumericField";
import { HsSelect, type HsSelectOption } from "../components/primitives/Select";
import { invalidManualTempo, invalidSelectionRange } from "./transcriptionParams";
import type { TranscriptionOptions } from "./types";

const TEMPO_OPTIONS: readonly HsSelectOption[] = [
  { value: "auto", label: ja.import.audioOptions.tempoAuto },
  { value: "manual", label: ja.import.audioOptions.tempoManual },
];
const METER_OPTIONS: readonly HsSelectOption[] = [
  { value: "auto", label: ja.import.audioOptions.meterAuto },
  { value: "4/4", label: "4/4" },
  { value: "3/4", label: "3/4" },
  { value: "6/8", label: "6/8" },
  { value: "2/4", label: "2/4" },
  { value: "5/4", label: "5/4" },
  { value: "7/8", label: "7/8" },
  { value: "9/8", label: "9/8" },
  { value: "12/8", label: "12/8" },
];
/* #53: key hint — tonic names in pitch-class order, both enharmonic
 *  spellings where they differ (Gb vs F#, D#m vs Ebm, G#m vs Abm),
 *  mirroring the engine's _KEY_HINTS table. */
const KEY_HINT_OPTIONS: readonly HsSelectOption[] = [
  { value: "auto", label: ja.import.audioOptions.keyHintAuto },
  ...["C", "Db", "D", "Eb", "E", "F", "Gb", "F#", "G", "Ab", "A", "Bb", "B"].map(
    (k) => ({ value: k, label: k }),
  ),
  ...["Cm", "C#m", "Dm", "D#m", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Abm", "Am", "Bbm", "Bm"].map(
    (k) => ({ value: k, label: k }),
  ),
];
const MIN_DURATION_OPTIONS: readonly HsSelectOption[] = [
  { value: "8", label: ja.import.audioOptions.minDuration8 },
  { value: "16", label: ja.import.audioOptions.minDuration16 },
  { value: "32", label: ja.import.audioOptions.minDuration32 },
];
const TRIPLET_OPTIONS: readonly HsSelectOption[] = [
  { value: "auto", label: ja.import.audioOptions.tripletsAuto },
  { value: "allow", label: ja.import.audioOptions.tripletsAllow },
  { value: "none", label: ja.import.audioOptions.tripletsNone },
];
const SIMPLICITY_OPTIONS: readonly HsSelectOption[] = [
  { value: "standard", label: ja.import.audioOptions.simplicityStandard },
  { value: "simple", label: ja.import.audioOptions.simplicitySimple },
  { value: "detailed", label: ja.import.audioOptions.simplicityDetailed },
];
const TEXTURE_OPTIONS: readonly HsSelectOption[] = [
  { value: "auto", label: ja.import.audioOptions.textureAuto },
  { value: "mono", label: ja.import.audioOptions.textureMono },
  { value: "melody", label: ja.import.audioOptions.textureMelody },
  { value: "voices", label: ja.import.audioOptions.textureVoices },
  { value: "chords", label: ja.import.audioOptions.textureChords },
];
const BACKEND_OPTIONS: readonly HsSelectOption[] = [
  { value: "auto", label: ja.import.audioOptions.backendAuto },
  { value: "basicPitch", label: "Basic Pitch" },
  { value: "pyin", label: ja.import.audioOptions.backendPyin },
];
/* #181: demucs tier for vocal isolation — only meaningful while the
 * isolation checkbox is on, so the select disables with it. */
const VOCAL_QUALITY_OPTIONS: readonly HsSelectOption[] = [
  {
    value: "standard",
    label: ja.import.audioOptions.vocalIsolationQualityStandard,
  },
  {
    value: "precision",
    label: ja.import.audioOptions.vocalIsolationQualityPrecision,
  },
];
const RANGE_OPTIONS: readonly HsSelectOption[] = [
  { value: "all", label: ja.import.audioOptions.rangeAll },
  // #88: 範囲採譜 — 時刻入力のほか、波形ドラッグでも選べる
  // (WaveformView の onSelect)。「ソロ部分だけ採譜」に対応。
  { value: "selection", label: ja.import.audioOptions.rangeSelection },
];

export function TranscriptionOptionsFields({
  options,
  durationSec,
  onChange,
  title,
  demucsAvailable,
}: {
  options: TranscriptionOptions;
  /** 読み込み済み音源の長さ(秒) — 範囲入力の上限と検証に使う。 */
  durationSec: number;
  onChange(next: TranscriptionOptions): void;
  /** Optional heading rendered above the fields (popover only — the
   *  dialog carries its title in the HsDialog chrome). */
  title?: string;
  /** #189: engine's demucsAvailable capability — false pins the
   *  quality select to standard since only demucs honors tiers;
   *  undefined means not-yet-known (engine still starting) and keeps
   *  the control enabled. */
  demucsAvailable?: boolean;
}) {
  const set = (patch: Partial<TranscriptionOptions>) =>
    onChange({ ...options, ...patch });
  // #346: an empty/inverted 選択範囲 is a field error — the caller also
  // uses this to gate its primary action.
  const rangeInvalid = invalidSelectionRange(options, durationSec);
  // #61: 手動 tempo with no BPM would silently fall back to auto.
  const tempoInvalid = invalidManualTempo(options);
  return (
    <div className="hs-audio-options">
      {title ? (
        <p className="hs-audio-options__title">{title}</p>
      ) : null}
      <HsSelect
        label={ja.import.audioOptions.texture}
        options={TEXTURE_OPTIONS}
        value={options.texture}
        hint={ja.import.audioOptions.textureHint(options.texture)}
        onChange={(v) =>
          set({ texture: v as TranscriptionOptions["texture"] })
        }
      />
      {/* #355: the voice cap only applies to the polyphonic
          textures — 4-part harmony needs 4+. */}
      {options.texture === "voices" || options.texture === "chords" ? (
        <HsNumericField
          label={ja.import.audioOptions.maxVoices}
          value={options.maxVoices}
          min={2}
          max={8}
          step={1}
          onChange={(v) =>
            set({
              maxVoices: Math.min(8, Math.max(2, Math.round(v ?? 3))),
            })
          }
        />
      ) : null}
      <HsSelect
        label={ja.import.audioOptions.backend}
        options={BACKEND_OPTIONS}
        value={options.backend}
        hint={ja.import.audioOptions.backendHint}
        onChange={(v) =>
          set({ backend: v as TranscriptionOptions["backend"] })
        }
      />
      {/* #187: opt-in vocal isolation — center extraction is a
          heuristic, so it stays a deliberate checkbox rather
          than a default. The engine reports whether it applied
          via a review issue either way. */}
      <Checkbox
        label={ja.import.audioOptions.vocalIsolation}
        checked={options.vocalIsolation}
        disabled={
          options.texture === "voices" || options.texture === "chords"
        }
        onChange={(_e, data) =>
          set({ vocalIsolation: data.checked === true })
        }
      />
      <p className="hs-audio-options__hint">
        {/* #322: voices/chords keep overlapping lines — vocal
            isolation strips the accompaniment first, so the
            two options contradict. The checkbox disables and
            the hint explains why instead of silently ignoring. */}
        {options.texture === "voices" || options.texture === "chords"
          ? ja.import.audioOptions.vocalIsolationPolyphonicHint
          : ja.import.audioOptions.vocalIsolationHint}
      </p>
      {/* #181: separation quality — only meaningful while the
          isolation checkbox is on, so the select disables with it.
          #189: without demucs every tier lands on the same center
          extraction — an enabled select would lie, so it disables too
          and the hint explains why. */}
      <HsSelect
        label={ja.import.audioOptions.vocalIsolationQuality}
        options={VOCAL_QUALITY_OPTIONS}
        value={options.vocalIsolationQuality}
        disabled={!options.vocalIsolation || demucsAvailable === false}
        hint={
          demucsAvailable === false
            ? ja.import.audioOptions.vocalIsolationQualityNoDemucs
            : ja.import.audioOptions.vocalIsolationQualityHint
        }
        onChange={(v) =>
          set({
            vocalIsolationQuality:
              v as TranscriptionOptions["vocalIsolationQuality"],
          })
        }
      />
      <HsSelect
        label={ja.import.audioOptions.tempo}
        options={TEMPO_OPTIONS}
        value={options.tempo}
        onChange={(v) =>
          set({ tempo: v as TranscriptionOptions["tempo"] })
        }
      />
      {options.tempo === "manual" ? (
        <HsNumericField
          label={ja.import.audioOptions.tempoBpm}
          value={options.tempoBpm}
          min={30}
          max={300}
          step={1}
          unit="BPM"
          error={
            tempoInvalid
              ? ja.import.audioOptions.tempoBpmRequired
              : undefined
          }
          onChange={(v) => set({ tempoBpm: v })}
        />
      ) : null}
      <HsSelect
        label={ja.import.audioOptions.meter}
        options={METER_OPTIONS}
        value={options.meter}
        onChange={(v) => set({ meter: v })}
      />
      {/* #53: 調を知っているユーザーはここで確定できる —
          音名表記・調号・コード事前分布がこの調に揃う。 */}
      <HsSelect
        label={ja.import.audioOptions.keyHint}
        options={KEY_HINT_OPTIONS}
        value={options.keyHint}
        hint={ja.import.audioOptions.keyHintHint}
        onChange={(v) => set({ keyHint: v })}
      />
      <HsSelect
        label={ja.import.audioOptions.minDuration}
        options={MIN_DURATION_OPTIONS}
        value={options.minDuration}
        onChange={(v) => set({ minDuration: v })}
      />
      <HsSelect
        label={ja.import.audioOptions.triplets}
        options={TRIPLET_OPTIONS}
        value={options.triplets}
        onChange={(v) =>
          set({ triplets: v as TranscriptionOptions["triplets"] })
        }
      />
      <HsSelect
        label={ja.import.audioOptions.simplicity}
        options={SIMPLICITY_OPTIONS}
        value={options.simplicity}
        onChange={(v) =>
          set({ simplicity: v as TranscriptionOptions["simplicity"] })
        }
      />
      <HsSelect
        label={ja.import.audioOptions.range}
        options={RANGE_OPTIONS}
        value={options.range}
        onChange={(v) =>
          set({ range: v as TranscriptionOptions["range"] })
        }
      />
      {options.range === "selection" && durationSec > 0 ? (
        <>
          <HsNumericField
            label={ja.import.audioOptions.rangeStart}
            value={options.selectionStartSec}
            min={0}
            max={durationSec}
            step={0.5}
            unit={ja.import.audioOptions.secondsUnit}
            onChange={(v) => set({ selectionStartSec: v })}
          />
          <HsNumericField
            label={ja.import.audioOptions.rangeEnd}
            value={options.selectionEndSec}
            min={0}
            max={durationSec}
            step={0.5}
            unit={ja.import.audioOptions.secondsUnit}
            error={
              rangeInvalid ? ja.import.audioOptions.rangeInvalid : undefined
            }
            onChange={(v) => set({ selectionEndSec: v })}
          />
        </>
      ) : null}
    </div>
  );
}
