import { useEffect, useState } from "react";
import { mergeClasses } from "@fluentui/react-components";
import { Dismiss16Regular } from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import { HsIconButton } from "./primitives/IconButton";
import { HsButton } from "./primitives/Button";
import { HsNumericField } from "./primitives/NumericField";
import { HsSelect } from "./primitives/Select";
import type { InspectorContent } from "../workspace/inspector";
import { startPointerResize } from "../workspace/layout";
import {
  headlinePitch,
  keyLabelJa,
  hornConcertFifths,
  type InspectorModel,
  type NoteInspectorModel,
  type ScoreInspectorModel,
} from "../score/inspector";
import type { KeyMode } from "../score/scoreDoc";
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
  onTempoScale,
  onMeterChange,
  onKeyChange,
  onKeyChangeAt,
  onRemoveKeyChange,
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
  /** #198: tempo-octave fix — scales BPM and note values together
   *  (the ÷2/×2 buttons; free-form BPM stays a setTempo relabel). */
  onTempoScale?(factor: number): void;
  /** #129 (§14): commit a new meter via the engine score.edit. */
  onMeterChange?(beatsPerMeasure: number, beatUnit: number): void;
  /** #145 (§14): commit a new key signature via the engine score.edit. */
  onKeyChange?(fifths: number, mode?: KeyMode | null): void;
  /** #145 (§14): insert/update a key-change boundary — startBeat
   *  "0/1" rewrites the head key in place; startMeasure names a
   *  barline and the engine resolves the beat. */
  onKeyChangeAt?(args: {
    fifths: number;
    mode?: KeyMode | null;
    startBeat?: string;
    startMeasure?: number;
  }): void;
  /** #145 (§14): drop the detected modulation at a measure. */
  onRemoveKeyChange?(startMeasure: number): void;
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
              onTempoScale={onTempoScale}
            onMeterChange={onMeterChange}
            onKeyChange={onKeyChange}
            onKeyChangeAt={onKeyChangeAt}
            onRemoveKeyChange={onRemoveKeyChange}
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
  onTempoScale,
  onMeterChange,
  onKeyChange,
  onKeyChangeAt,
  onRemoveKeyChange,
}: {
  model: InspectorModel;
  pitch: PitchView;
  onTempoChange?(bpm: number): void;
  onTempoScale?(factor: number): void;
 onMeterChange?(beatsPerMeasure: number, beatUnit: number): void;
  onKeyChange?(fifths: number, mode?: KeyMode | null): void;
  onKeyChangeAt?(args: {
    fifths: number;
    mode?: KeyMode | null;
    startBeat?: string;
    startMeasure?: number;
  }): void;
  onRemoveKeyChange?(startMeasure: number): void;
}) {
  if (model.kind === "score") {
    return (
      <ScoreBody
        model={model}
        pitch={pitch}
        onTempoChange={onTempoChange}
        onTempoScale={onTempoScale}
        onMeterChange={onMeterChange}
        onKeyChange={onKeyChange}
        onKeyChangeAt={onKeyChangeAt}
        onRemoveKeyChange={onRemoveKeyChange}
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
  pitch,
  onTempoChange,
  onTempoScale,
  onMeterChange,
  onKeyChange,
  onKeyChangeAt,
  onRemoveKeyChange,
}: {
  model: ScoreInspectorModel;
  pitch: PitchView;
  onTempoChange?(bpm: number): void;
  onTempoScale?(factor: number): void;
  onMeterChange?(beatsPerMeasure: number, beatUnit: number): void;
  onKeyChange?(fifths: number, mode?: KeyMode | null): void;
  onKeyChangeAt?(args: {
    fifths: number;
    mode?: KeyMode | null;
    startBeat?: string;
    startMeasure?: number;
  }): void;
  onRemoveKeyChange?(startMeasure: number): void;
}) {
  const f = ja.inspector.summaryFields;
  return (
    <>
      <dl className="hs-properties__rows">
        <Row label={f.title} value={model.title} />
        {model.tempoBpm != null && onTempoChange ? (
          <TempoField
            bpm={model.tempoBpm}
            onCommit={onTempoChange}
            onScale={onTempoScale}
          />
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
          <KeyField
            fifths={model.keyFifths}
            mode={model.keyMode}
            onCommit={(fifths, mode) =>
              // #270: model.keyFifths is in the viewed presentation —
              // a written-view pick maps back to the concert signature
              // the engine setKey edit expects.
              onKeyChange(
                pitch === "hornF" ? hornConcertFifths(fifths) : fifths,
                mode,
              )
            }
          />
        ) : model.keyChangeCount > 1 &&
          onKeyChangeAt &&
          onRemoveKeyChange ? (
          // #145: modulating scores get the key-map editor — every
          // detected boundary editable/removable, new ones addable,
          // and "unify" is the explicit global setKey path.
          <KeyMapEditor
            changes={model.keyChanges}
            measureCount={model.measureCount}
            onHeadChange={(fifths, mode) =>
              onKeyChangeAt({
                fifths:
                  pitch === "hornF" ? hornConcertFifths(fifths) : fifths,
                mode,
                startBeat: "0/1",
              })
            }
            onBoundaryChange={(measure, fifths, mode) =>
              onKeyChangeAt({
                fifths:
                  pitch === "hornF" ? hornConcertFifths(fifths) : fifths,
                mode,
                startMeasure: measure,
              })
            }
            onRemove={(measure) => onRemoveKeyChange(measure)}
            onUnify={
              onKeyChange
                ? (fifths, mode) =>
                    onKeyChange(
                      pitch === "hornF"
                        ? hornConcertFifths(fifths)
                        : fifths,
                      mode,
                    )
                : undefined
            }
          />
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
 * Modulating scores get the KeyMapEditor instead — each detected
 * boundary stays editable without collapsing the map. */
const KEY_FIFTHS_OPTIONS = [
  -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7,
] as const;

/** #145: signature + mode select pair shared by the single-key field,
 *  the key-map rows and the "add" row. Labels carry the measure so
 *  every control keeps a unique accessible name. */
function KeyField({
  fifths,
  mode,
  onCommit,
}: {
  fifths: number;
  mode: KeyMode | null;
  onCommit(fifths: number, mode?: KeyMode | null): void;
}) {
  const f = ja.inspector.summaryFields;
  return (
    <KeySelects
      fifths={fifths}
      mode={mode}
      keyLabel={f.key}
      modeLabel={f.keyMode}
      onCommit={onCommit}
    />
  );
}

function KeySelects({
  fifths,
  mode,
  keyLabel,
  modeLabel,
  onCommit,
}: {
  fifths: number;
  mode: KeyMode | null;
  keyLabel: string;
  modeLabel: string;
  onCommit(fifths: number, mode: KeyMode): void;
}) {
  const mode_ = mode ?? "major";
  return (
    <div className="hs-properties__meter">
      <HsSelect
        label={keyLabel}
        value={String(fifths)}
        options={KEY_FIFTHS_OPTIONS.map((v) => ({
          value: String(v),
          label: keyLabelJa(v, mode_),
        }))}
        onChange={(v) => {
          const next = Number(v);
          if (!Number.isFinite(next) || next === fifths) return;
          onCommit(next, mode_);
        }}
      />
      <HsSelect
        label={modeLabel}
        value={mode_}
        options={[
          { value: "major", label: ja.inspector.keyModes.major },
          { value: "minor", label: ja.inspector.keyModes.minor },
        ]}
        onChange={(v) => {
          if (v !== "major" && v !== "minor") return;
          if (v === mode_) return;
          onCommit(fifths, v);
        }}
      />
    </div>
  );
}

/* #145 (§14) key-map editor: modulating scores list every detected
 *  boundary — row 0 is the head key (edited in place, the map
 *  survives); later rows edit/delete their barline. A new boundary
 *  can be added at any measure, and "1つの調に統一" is the explicit
 *  global setKey path (collapses the map to the head key). */
function KeyMapEditor({
  changes,
  measureCount,
  onHeadChange,
  onBoundaryChange,
  onRemove,
  onUnify,
}: {
  changes: readonly {
    readonly measure: number;
    readonly fifths: number;
    readonly mode: KeyMode | null;
  }[];
  measureCount: number;
  onHeadChange(fifths: number, mode: KeyMode): void;
  onBoundaryChange(measure: number, fifths: number, mode: KeyMode): void;
  onRemove(measure: number): void;
  onUnify?(fifths: number, mode: KeyMode): void;
}) {
  const km = ja.inspector.keyMap;
  const [addMeasure, setAddMeasure] = useState<number | null>(null);
  const [addFifths, setAddFifths] = useState(0);
  const [addMode, setAddMode] = useState<KeyMode>("major");
  const addValid =
    addMeasure != null && addMeasure >= 1 && addMeasure <= measureCount;
  return (
    <div className="hs-properties__keymap">
      {changes.map((c, i) => {
        const commit = (fifths: number, mode: KeyMode) =>
          i === 0
            ? onHeadChange(fifths, mode)
            : onBoundaryChange(c.measure, fifths, mode);
        return (
          <div className="hs-properties__keymap-row" key={i}>
            <span className="hs-properties__keymap-measure">
              {i === 0 ? km.head : km.measureAt(c.measure)}
            </span>
            <KeySelects
              fifths={c.fifths}
              mode={c.mode}
              keyLabel={km.keyAt(c.measure)}
              modeLabel={km.modeAt(c.measure)}
              onCommit={commit}
            />
            {i > 0 ? (
              <HsIconButton
                label={km.remove}
                icon={<Dismiss16Regular />}
                size="small"
                onClick={() => onRemove(c.measure)}
              />
            ) : null}
          </div>
        );
      })}
      <div className="hs-properties__keymap-add">
        <HsNumericField
          label={km.measure}
          value={addMeasure}
          min={1}
          max={measureCount}
          step={1}
          onChange={(v) => setAddMeasure(v)}
        />
        <KeySelects
          fifths={addFifths}
          mode={addMode}
          keyLabel={km.key}
          modeLabel={km.mode}
          onCommit={(fifths, mode) => {
            setAddFifths(fifths);
            setAddMode(mode);
          }}
        />
        <HsButton
          variant="secondary"
          size="small"
          disabled={!addValid}
          onClick={() => {
            if (!addValid || addMeasure == null) return;
            onBoundaryChange(addMeasure, addFifths, addMode);
          }}
        >
          {km.add}
        </HsButton>
      </div>
      {onUnify ? (
        <HsButton
          variant="subtle"
          size="small"
          ariaLabel={km.unifyHint}
          onClick={() =>
            onUnify(changes[0]?.fifths ?? 0, changes[0]?.mode ?? "major")
          }
        >
          {km.unify}
        </HsButton>
      ) : null}
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
  onScale,
}: {
  bpm: number;
  onCommit(bpm: number): void;
  /** #198: tempo-octave fix — rescales BPM and note values together.
   *   Absent, the ÷2/×2 buttons hide (the BPM field alone cannot fix
   *   written note values). */
  onScale?(factor: number): void;
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
      {/* #188: auto tempo estimation's classic failure is a half/
          double-octave pick — one-tap ×2/÷2 beats re-transcribing.
          #198: these rescale note values with the BPM (scaleTempo),
          not a bare relabel — playback seconds stay invariant. */}
      {onScale ? (
        <div className="hs-properties__tempo-octave">
          <HsButton
            size="small"
            variant="subtle"
            disabled={bpm / 2 < TEMPO_MIN_BPM}
            onClick={() => onScale(0.5)}
          >
            {ja.inspector.tempoHalve}
          </HsButton>
          <HsButton
            size="small"
            variant="subtle"
            disabled={bpm * 2 > TEMPO_MAX_BPM}
            onClick={() => onScale(2)}
          >
            {ja.inspector.tempoDouble}
          </HsButton>
        </div>
      ) : null}
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
