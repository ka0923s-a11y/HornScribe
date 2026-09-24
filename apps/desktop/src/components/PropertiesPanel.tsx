import { useEffect, useState } from "react";
import { mergeClasses } from "@fluentui/react-components";
import { Dismiss16Regular } from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import { HsIconButton } from "./primitives/IconButton";
import { HsNumericField } from "./primitives/NumericField";
import { HsSelect } from "./primitives/Select";
import type { InspectorContent } from "../workspace/inspector";
import { startPointerResize } from "../workspace/layout";
import {
  headlinePitch,
  keyLabelJa,
  type InspectorModel,
  type NoteInspectorModel,
  type ScoreInspectorModel,
} from "../score/inspector";
import type { PitchView } from "./PitchSegmented";

/**
 * Properties inspector (GUI_UX_SPEC §6, §21; inspector contract in
 * workspace/inspector.ts).
 *
 * - Docked on the right at ≥1200px; below that it renders as a non-modal
 *   overlay drawer so the score keeps priority (§21).
 * - User-closable (acceptance: properties can be closed); the command-bar
 *   overflow menu reopens it.
 * - `content` is the shell's selection contract; `model` is the UI-030
 *   feature view-model (note rows / score summary) built by
 *   score/inspector.ts — all Japanese text is precomputed there so the
 *   readable properties stay screen-reader accessible as plain DOM (§24).
 *   Without a model the placeholder body shows.
 * - Left-edge separator resizes within the breakpoint clamps.
 */
export function PropertiesPanel({
  content,
  model,
  pitch = "concert",
  width,
  min,
  max,
  overlay,
  onResize,
  onReset,
  onClose,
  onTempoChange,
  onMeterChange,
  onKeyChange,
}: {
  content: InspectorContent;
  /** UI-030 feature inspector view-model (note/score/range bodies). */
  model?: InspectorModel;
  /** Pitch view the user is looking at - leads the note headline. */
  pitch?: PitchView;
  width: number;
  min: number;
  max: number;
  /** <1200px: overlay the score instead of docking beside it. */
  overlay: boolean;
  onResize(px: number): void;
  onReset(): void;
  onClose(): void;
  /** §14: commit a new head tempo (BPM) via the engine score.edit. */
  onTempoChange?(bpm: number): void;
  /** #129 (§14): commit a new meter via the engine score.edit. */
  onMeterChange?(beatsPerMeasure: number, beatUnit: number): void;
  /** #145 (§14): commit a new key signature via the engine score.edit. */
  onKeyChange?(fifths: number): void;
}) {
  const body =
    model && model.kind !== "empty" ? model.kind : content.kind;
  return (
    <aside
      className={mergeClasses(
        "hs-properties",
        overlay && "hs-properties--overlay",
      )}
      style={{ width }}
      aria-label={ja.properties.regionLabel}
      data-hs-focus-zone="properties"
      tabIndex={0}
    >
      <div className="hs-properties__frame">
        <header className="hs-properties__header">
          <h2 className="hs-properties__title">{ja.properties.title}</h2>
          <HsIconButton
            label={ja.properties.close}
            icon={<Dismiss16Regular />}
            size="small"
            onClick={onClose}
          />
        </header>
        <div className="hs-properties__body" data-inspector={body}>
          {model && model.kind !== "empty" ? (
            <InspectorBody
              model={model}
              pitch={pitch}
              onTempoChange={onTempoChange}
              onMeterChange={onMeterChange}
              onKeyChange={onKeyChange}
            />
          ) : (
            <p className="hs-properties__placeholder">
              {ja.properties.placeholder}
            </p>
          )}
        </div>
      </div>
      <div
        className="hs-properties__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={ja.properties.resizeHandle}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(e) => {
          const startW = width;
          const startX = e.clientX;
          // Panel is right-anchored: dragging left grows it.
          startPointerResize(e, onResize, (x) => startW + (startX - x));
        }}
        onKeyDown={(e) => {
          // ← grows (panel expands leftward), → shrinks.
          const step = e.key === "ArrowLeft" ? 8 : e.key === "ArrowRight" ? -8 : null;
          if (step != null) {
            e.preventDefault();
            onResize(width + step);
          }
        }}
        onDoubleClick={onReset}
      />
    </aside>
  );
}

/** Feature body per inspector kind (GUI_UX_PLAN §22). */
function InspectorBody({
  model,
  pitch,
  onTempoChange,
  onMeterChange,
  onKeyChange,
}: {
  model: InspectorModel;
  pitch: PitchView;
  onTempoChange?(bpm: number): void;
  onMeterChange?(beatsPerMeasure: number, beatUnit: number): void;
  onKeyChange?(fifths: number): void;
}) {
  if (model.kind === "score") {
    return (
      <ScoreBody
        model={model}
        onTempoChange={onTempoChange}
        onMeterChange={onMeterChange}
        onKeyChange={onKeyChange}
      />
    );
  }
  if (model.kind === "note") return <NoteBody model={model} pitch={pitch} />;
  if (model.kind === "range") {
    const f = ja.inspector.fields;
    return (
      <dl className="hs-properties__rows">
        <Row label={f.onset} value={model.startLabel} />
        <Row label={f.duration} value={model.endLabel} />
      </dl>
    );
  }
  return null;
}

/** §22 "Nothing selected" - score/measure summary. */
function ScoreBody({
  model,
  onTempoChange,
  onMeterChange,
  onKeyChange,
}: {
  model: ScoreInspectorModel;
  onTempoChange?(bpm: number): void;
  onMeterChange?(beatsPerMeasure: number, beatUnit: number): void;
  onKeyChange?(fifths: number): void;
}) {
  const f = ja.inspector.summaryFields;
  return (
    <>
      <dl className="hs-properties__rows">
        <Row label={f.title} value={model.title} />
        {model.tempoBpm != null && onTempoChange ? (
          <TempoField bpm={model.tempoBpm} onCommit={onTempoChange} />
        ) : (
          model.tempoLabel && <Row label={f.tempo} value={model.tempoLabel} />
        )}
        {model.meterBeats != null && model.meterUnit != null && onMeterChange ? (
          <MeterField
            beats={model.meterBeats}
            unit={model.meterUnit}
            onCommit={onMeterChange}
          />
        ) : (
          model.meterLabel && <Row label={f.meter} value={model.meterLabel} />
        )}
        {model.keyFifths != null &&
        model.keyChangeCount <= 1 &&
        onKeyChange ? (
          <KeyField fifths={model.keyFifths} onCommit={onKeyChange} />
        ) : (
          model.keyLabel && <Row label={f.key} value={model.keyLabel} />
        )}
        <Row label={f.measures} value={model.measureLabel} />
        {model.swingFeel ? (
          <Row label={f.feel} value={ja.inspector.feelSwing} />
        ) : null}
        <Row label={f.notes} value={model.noteLabel} />
        <Row label={f.openIssues} value={model.openIssueLabel} />
      </dl>
      <p className="hs-properties__placeholder">{ja.inspector.selectHint}</p>
    </>
  );
}

/* #145 (§14) key edit: the score summary's key row becomes a select
 * over the 15 fifths signatures (shown with Japanese key names).
 * Modulating scores show the transition label instead — a head-key
 * edit would collapse the detected changes. */
const KEY_FIFTHS_OPTIONS = [
  -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7,
] as const;

function KeyField({
  fifths,
  onCommit,
}: {
  fifths: number;
  onCommit(fifths: number): void;
}) {
  const f = ja.inspector.summaryFields;
  return (
    <div className="hs-properties__meter">
      <HsSelect
        label={f.key}
        value={String(fifths)}
        options={KEY_FIFTHS_OPTIONS.map((v) => ({
          value: String(v),
          label: keyLabelJa(v),
        }))}
        onChange={(v) => {
          const next = Number(v);
          if (!Number.isFinite(next) || next === fifths) return;
          onCommit(next);
        }}
      />
    </div>
  );
}

/* §14 tempo edit: the score summary's BPM row becomes an editable
 * field. Commits on blur / Enter / stepper click (not per keystroke, so
 * typing "96" does not fire two engine edits); out-of-range input shows
 * a field error and never reaches the engine. */
const TEMPO_MIN_BPM = 20;
const TEMPO_MAX_BPM = 400;

function TempoField({
  bpm,
  onCommit,
}: {
  bpm: number;
  onCommit(bpm: number): void;
}) {
  const f = ja.inspector.summaryFields;
  const [draft, setDraft] = useState<number | null>(bpm);
  const [error, setError] = useState<string | null>(null);
  // Re-sync the draft whenever the engine reports a new tempo (edit,
  // undo, or a different score).
  useEffect(() => {
    setDraft(bpm);
    setError(null);
  }, [bpm]);
  const commitValue = (v: number | null) => {
    if (v == null) {
      setDraft(bpm);
      setError(null);
      return;
    }
    if (v < TEMPO_MIN_BPM || v > TEMPO_MAX_BPM) {
      setError(ja.inspector.tempoRangeError);
      return;
    }
    setError(null);
    if (v !== bpm) onCommit(v);
  };
  const commit = () => commitValue(draft);
  return (
    <div
      className="hs-properties__tempo"
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    >
      <HsNumericField
        label={f.tempo}
        value={draft}
        min={TEMPO_MIN_BPM}
        max={TEMPO_MAX_BPM}
        step={1}
        unit="BPM"
        error={error ?? undefined}
        onChange={(v) => {
          setDraft(v);
          if (v != null) commitValue(v);
        }}
      />
    </div>
  );
}

/* #129 (§14) meter edit: the score summary's meter row becomes a
 * select over the common signatures. Choosing a new value commits
 * immediately — the engine re-tiles the whole score, so a no-op pick
 * (same signature) is filtered out here. */
const METER_OPTIONS = [
  "2/4",
  "3/4",
  "4/4",
  "5/4",
  "6/8",
  "9/8",
  "12/8",
  "2/2",
  "3/8",
  "7/8",
] as const;

function MeterField({
  beats,
  unit,
  onCommit,
}: {
  beats: number;
  unit: number;
  onCommit(beatsPerMeasure: number, beatUnit: number): void;
}) {
  const f = ja.inspector.summaryFields;
  const current = `${beats}/${unit}`;
  // An unusual current meter (e.g. 5/8 from the engine) stays selectable
  // so the field reflects the score instead of snapping to a preset.
  const values = METER_OPTIONS.includes(current as (typeof METER_OPTIONS)[number])
    ? METER_OPTIONS
    : [current, ...METER_OPTIONS];
  return (
    <div className="hs-properties__meter">
      <HsSelect
        label={f.meter}
        value={current}
        options={values.map((v) => ({ value: v, label: v }))}
        onChange={(v) => {
          const m = /^(\d+)\/(\d+)$/.exec(v);
          if (!m) return;
          const b = Number(m[1]);
          const u = Number(m[2]);
          if (b === beats && u === unit) return;
          onCommit(b, u);
        }}
      />
    </div>
  );
}

/** §22 "Note selected" - pitch, onset, duration, review info. */
function NoteBody({
  model,
  pitch,
}: {
  model: NoteInspectorModel;
  pitch: PitchView;
}) {
  const f = ja.inspector.fields;
  const { primary, secondary } = headlinePitch(model, pitch);
  return (
    <>
      <h3 className="hs-properties__section">{ja.inspector.noteSection}</h3>
      <dl className="hs-properties__rows">
        <Row label={f.pitch} value={primary} strong />
        {secondary && (
          <Row
            label={pitch === "hornF" ? f.concertPitch : f.writtenPitch}
            value={secondary}
          />
        )}
        <Row label={f.duration} value={model.durationLabel} />
        <Row label={f.onset} value={model.onsetLabel} />
        {model.tieLabel && <Row label={f.tie} value={model.tieLabel} />}
        {model.canonicalId && <Row label={f.canonicalId} value={model.canonicalId} />}
      </dl>
      {model.issues.length > 0 && (
        <>
          <h3 className="hs-properties__section">{ja.inspector.issuesSection}</h3>
          <ul className="hs-properties__issues">
            {model.issues.map((issue) => (
              <li key={issue.id} className="hs-properties__issue">
                <p className="hs-properties__issue-title">
                  <span className="hs-properties__issue-badge">
                    {ja.reviewBadge.needsReview}
                  </span>
                  {issue.reasonTitle}
                </p>
                <p className="hs-properties__issue-detail">{issue.reasonDetail}</p>
                <p className="hs-properties__issue-meta">
                  {issue.severityLabel}
                  {` ・ ${issue.statusLabel}`}
                  {issue.confidencePct != null &&
                    ` ・ ${f.confidence} ${issue.confidencePct}%`}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Row({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="hs-properties__row">
      <dt>{label}</dt>
      <dd className={strong ? "hs-properties__value--strong" : undefined}>
        {value}
      </dd>
    </div>
  );
}
