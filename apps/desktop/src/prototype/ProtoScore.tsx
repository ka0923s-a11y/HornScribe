import { forwardRef } from "react";
import { ja } from "../strings/ja";
import {
  diatonicStep,
  hasAccidental,
  measureAtTime,
  noteName,
  writtenMidi,
  type MockIssue,
  type MockNote,
  type PitchView,
} from "./mockData";

/**
 * Mock score — continuous view (連続表示, GUI_UX_SPEC §10 default candidate).
 * Notes are real SVG glyphs laid out on a staff so density/hierarchy reads
 * like a score; engraving correctness is a non-goal (issue non-goals).
 *
 * Selection / playback highlight / review markers are all driven by props so
 * the same surface serves the shell, score, review and export states.
 */

const MEASURES_PER_SYSTEM = 4;
const MEASURE_W = 168;
const LEFT_PAD = 56;
const SYSTEM_H = 148;
const STAFF_TOP = 52; // y of the top staff line inside a system block
const LINE_GAP = 8; // distance between staff lines
const BOTTOM_STEP = diatonicStep(64); // E4 = bottom line (treble staff)

function stepToY(midi: number): number {
  return STAFF_TOP + 4 * LINE_GAP - (diatonicStep(midi) - BOTTOM_STEP) * (LINE_GAP / 2);
}

function noteX(note: MockNote): number {
  const m = (note.measure - 1) % MEASURES_PER_SYSTEM;
  return LEFT_PAD + m * MEASURE_W + (note.beat - 1) * 40 + 14;
}

function systemIndex(measure: number): number {
  return Math.floor((measure - 1) / MEASURES_PER_SYSTEM);
}

function systemTop(measure: number): number {
  return systemIndex(measure) * SYSTEM_H;
}

function NoteGlyph({ midi, beats }: { midi: number; beats: number }) {
  const y = stepToY(midi);
  const hollow = beats >= 2;
  const stemUp = diatonicStep(midi) < diatonicStep(71); // below B4 → stem up
  const stemLen = 30;
  const ink = "var(--hs-proto-ink)";
  const ledgers: number[] = [];
  // Ledger lines for notes outside the 5-line staff.
  for (let s = 1; STAFF_TOP + 4 * LINE_GAP + s * LINE_GAP <= y; s++) {
    ledgers.push(STAFF_TOP + 4 * LINE_GAP + s * LINE_GAP);
  }
  for (let s = 1; STAFF_TOP - s * LINE_GAP >= y; s++) {
    ledgers.push(STAFF_TOP - s * LINE_GAP);
  }
  return (
    <>
      {ledgers.map((ly) => (
        <line key={ly} x1={-11} x2={11} y1={ly - y} y2={ly - y} stroke={ink} strokeWidth={1} />
      ))}
      {hasAccidental(midi) && (
        <text x={-16} y={4} fontSize={13} fill={ink} textAnchor="middle">
          ♯
        </text>
      )}
      <ellipse
        cx={0}
        cy={0}
        rx={5.4}
        ry={3.8}
        transform="rotate(-18)"
        fill={hollow ? "var(--hs-surface-score)" : ink}
        stroke={ink}
        strokeWidth={1.4}
        className="hs-proto-note__head"
      />
      {beats < 4 && (
        <line
          x1={stemUp ? 5 : -5}
          x2={stemUp ? 5 : -5}
          y1={0}
          y2={stemUp ? -stemLen : stemLen}
          stroke={ink}
          strokeWidth={1.3}
          className="hs-proto-note__stem"
        />
      )}
    </>
  );
}

export interface ProtoScoreProps {
  notes: MockNote[];
  pitch: PitchView;
  selectedId: string | null;
  onSelect(id: string | null): void;
  /** Playback position in seconds; null = no highlight. */
  positionSec: number | null;
  /** Issue markers (dotted underline + glyph) rendered on pending issues. */
  issues?: MockIssue[];
  focusedIssueId?: string | null;
  onBackgroundClick?(): void;
  /** Manual scroll inside the score surface (drives follow suspension). */
  onScroll?(): void;
}

export const ProtoScore = forwardRef<HTMLDivElement, ProtoScoreProps>(
  function ProtoScore(
    { notes, pitch, selectedId, onSelect, positionSec, issues, focusedIssueId, onBackgroundClick, onScroll },
    ref,
  ) {
    const systems = Math.ceil(12 / MEASURES_PER_SYSTEM);
    const width = LEFT_PAD + MEASURES_PER_SYSTEM * MEASURE_W + 20;
    const height = systems * SYSTEM_H + 24;
    const activeMeasure = positionSec != null ? measureAtTime(positionSec) : null;
    const issueByNote = new Map((issues ?? []).map((i) => [i.noteId, i]));

    return (
      <div
        ref={ref}
        className="hs-proto-score"
        role="region"
        aria-label={ja.prototype.scoreView.regionLabel}
        tabIndex={0}
        onClick={onBackgroundClick}
        onScroll={onScroll}
      >
        <svg
          width={width}
          height={height}
          className="hs-proto-score__svg"
          role="presentation"
        >
          {pitch === "hornF" && (
            <text x={8} y={20} fontSize={12} className="hs-proto-score__caption">
              F管ホルン（{ja.prototype.scoreView.hornCaption}）
            </text>
          )}
          {Array.from({ length: systems }, (_, sys) => {
            const top = sys * SYSTEM_H;
            const firstMeasure = sys * MEASURES_PER_SYSTEM + 1;
            const lastMeasure = Math.min(firstMeasure + MEASURES_PER_SYSTEM - 1, 12);
            return (
              <g key={sys} transform={`translate(0,${top})`}>
                {/* staff lines */}
                {[0, 1, 2, 3, 4].map((l) => (
                  <line
                    key={l}
                    x1={LEFT_PAD - 8}
                    x2={LEFT_PAD + MEASURES_PER_SYSTEM * MEASURE_W}
                    y1={STAFF_TOP + l * LINE_GAP}
                    y2={STAFF_TOP + l * LINE_GAP}
                    stroke="var(--hs-proto-ink)"
                    strokeWidth={1}
                  />
                ))}
                {/* barlines + measure numbers */}
                {Array.from({ length: lastMeasure - firstMeasure + 2 }, (_, i) => {
                  const m = firstMeasure + i;
                  const x = LEFT_PAD + i * MEASURE_W;
                  const isEnd = i === lastMeasure - firstMeasure + 1;
                  return (
                    <g key={i}>
                      <line
                        x1={x}
                        x2={x}
                        y1={STAFF_TOP}
                        y2={STAFF_TOP + 4 * LINE_GAP}
                        stroke="var(--hs-proto-ink)"
                        strokeWidth={isEnd ? 3 : 1}
                      />
                      {m <= 12 && (
                        <text
                          x={x + 3}
                          y={STAFF_TOP - 8}
                          fontSize={10}
                          className="hs-proto-score__measureNo"
                        >
                          {m}
                        </text>
                      )}
                    </g>
                  );
                })}
                {/* playback measure wash (subtle, §10) */}
                {activeMeasure != null &&
                  activeMeasure >= firstMeasure &&
                  activeMeasure <= lastMeasure && (
                    <rect
                      x={LEFT_PAD + (activeMeasure - firstMeasure) * MEASURE_W}
                      y={STAFF_TOP - 16}
                      width={MEASURE_W}
                      height={4 * LINE_GAP + 32}
                      fill="var(--hs-score-current-measure)"
                    />
                  )}
              </g>
            );
          })}

          {notes.map((note) => {
            if (note.deleted) return null;
            const x = noteX(note);
            const displayMidi = writtenMidi(note.midiConcert, pitch);
            const y = systemTop(note.measure) + stepToY(displayMidi);
            const selected = note.id === selectedId;
            const issue = issueByNote.get(note.id);
            const isFocusedIssue = issue && issue.id === focusedIssueId;
            return (
              <g
                key={note.id}
                transform={`translate(${x},${y})`}
                role="button"
                aria-label={`第${note.measure}小節 ${note.beat}拍 ${noteName(displayMidi)}`}
                aria-pressed={selected}
                tabIndex={-1}
                className="hs-proto-note"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(note.id);
                }}
              >
                {selected && (
                  <rect
                    x={-14}
                    y={-16}
                    width={30}
                    height={note.durationBeats < 4 ? 48 : 34}
                    rx={4}
                    fill="var(--hs-score-selection)"
                    stroke="var(--hs-accent)"
                    strokeWidth={1}
                  />
                )}
                <NoteGlyph midi={displayMidi} beats={note.durationBeats} />
                {issue && (
                  <g
                    aria-hidden="true"
                    className={isFocusedIssue ? "hs-proto-issue hs-proto-issue--focus" : "hs-proto-issue"}
                  >
                    <line
                      x1={-10}
                      x2={12}
                      y1={14}
                      y2={14}
                      stroke="var(--hs-review-marker)"
                      strokeWidth={2}
                      strokeDasharray="3 3"
                    />
                    <circle cx={0} cy={-26} r={6} fill="var(--hs-review-marker)" />
                    <text x={0} y={-22.5} fontSize={9} textAnchor="middle" fill="var(--hs-surface-score)">
                      ?
                    </text>
                  </g>
                )}
                {/* enlarge hit area */}
                <rect x={-14} y={-34} width={30} height={60} fill="transparent" />
              </g>
            );
          })}
        </svg>
      </div>
    );
  },
);

export const SCORE_METRICS = {
  MEASURES_PER_SYSTEM,
  MEASURE_W,
  LEFT_PAD,
  SYSTEM_H,
  STAFF_TOP,
  systemTop,
  systemIndex,
};
