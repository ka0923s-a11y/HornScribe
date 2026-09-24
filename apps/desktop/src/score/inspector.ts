/**
 * Inspector contract (UI-030) — the view-model bridge between the score
 * workspace and the properties panel (GUI_UX_PLAN §22: the inspector body
 * changes with the selection context).
 *
 * The workspace builds an `InspectorModel`; `PropertiesPanel` renders it.
 * All Japanese text is produced HERE so the panel stays a dumb renderer and
 * the copy stays testable in one place.
 *
 * Contexts (§22):
 *   - note selected → pitch (written/concert), onset, duration, review info
 *   - nothing selected → score/measure summary
 *   - time range selected → reserved for the waveform range path (UI-020+)
 */
import type { ScoreDocumentMeta } from "./document";
import type { ScoreReviewIssue } from "./review";
import { issueConfidence } from "./review";
import { noteTypeJa, pitchLabel, type KeyMode, type ParsedNote } from "./scoreDoc";
import type { PitchViewSetting } from "../commands/types";

export interface InspectorIssueRow {
  readonly id: string;
  /** Japanese reason title (copy deck mapping in ja.ts). */
  readonly reasonTitle: string;
  readonly reasonDetail: string;
  readonly severityLabel: string;
  readonly statusLabel: string;
  /** 0–100 integer percent, when the issue carries confidence evidence. */
  readonly confidencePct: number | null;
}

export interface NoteInspectorModel {
  readonly kind: "note";
  /** Canonical `sn-*` id — the only identity shown to the user.
   *  `null` for rests (presentation-only `hs-rest-*` ids). */
  readonly canonicalId: string | null;
  /** Measure number (1-based) of the first fragment. */
  readonly measure: number;
  /** Concert-pitch label, e.g. "B♭3" — always shown (canonical truth). */
  readonly concertPitch: string;
  /** Written F管 label, e.g. "F4" — shown when it differs ( horn view / info ). */
  readonly writtenPitch: string | null;
  /** Japanese duration label, e.g. "付点四分音符". */
  readonly durationLabel: string;
  /** Onset inside the score, e.g. "第3小節（スコア 7.2 秒）". */
  readonly onsetLabel: string;
  /** Tie-fragment note, e.g. "タイで分割（3分割）". */
  readonly tieLabel: string | null;
  readonly issues: readonly InspectorIssueRow[];
}

export interface ScoreInspectorModel {
  readonly kind: "score";
  readonly title: string;
  readonly tempoLabel: string | null;
  /** Raw tempo for the editable BPM field (#115 setTempo). */
  readonly tempoBpm: number | null;
  readonly meterLabel: string | null;
  /** Raw meter for the editable field (#129 setMeter), parsed from the
   *  "n/m" label — null when the score carries no usable signature. */
  readonly meterBeats: number | null;
  readonly meterUnit: number | null;
  readonly keyLabel: string | null;
 /** Raw head-key fifths for the editable key field (#145 setKey). */
 readonly keyFifths: number | null;
  /** #252: head-key mode for the key field (null = major default). */
  readonly keyMode: KeyMode | null;
  /** Number of key-signature boundaries; >1 means the piece modulates
   *  and the summary shows transitions instead of an editable field. */
  readonly keyChangeCount: number;
  /** #145: the key-change map for the boundary editor — each entry
   *  carries the viewed presentation's fifths (concert or written),
   *  matching keyFifths' projection. */
  readonly keyChanges: readonly {
    readonly measure: number;
    readonly fifths: number;
    readonly mode: KeyMode | null;
  }[];
  /** Raw measure count for the "add key change" field's max. */
  readonly measureCount: number;
  /** #134: the score carries a swing marking — shown as a feel row. */
  readonly swingFeel: boolean;
  readonly measureLabel: string;
  readonly noteLabel: string;
  readonly openIssueLabel: string;
}

export interface RangeInspectorModel {
  readonly kind: "range";
  readonly startLabel: string;
  readonly endLabel: string;
}

/** No score loaded — panel placeholder (EMPTY/AUDIO_READY/TRANSCRIBING). */
export interface EmptyInspectorModel {
  readonly kind: "empty";
}

export type InspectorModel =
  | NoteInspectorModel
  | ScoreInspectorModel
  | RangeInspectorModel
  | EmptyInspectorModel;

export interface ReviewCopy {
  reasonTitle(reason: ScoreReviewIssue["reason"]): string;
  /** Detail may look at the issue's evidence (counts, ranges) — the
   *  copy layer decides what is safe to surface. */
  reasonDetail(issue: ScoreReviewIssue): string;
  severityLabel(severity: ScoreReviewIssue["severity"]): string;
  statusLabel(status: ScoreReviewIssue["status"]): string;
}

export interface InspectorCopy {
  readonly review: ReviewCopy;
  /** e.g. (n) => `第${n}小節` */
  measure(n: number): string;
  /** e.g. (sec) => `スコア ${sec} 秒` */
  scoreSeconds(sec: number): string;
  /** e.g. (n) => `タイで分割（${n}分割）` */
  tieFragments(count: number): string;
  /** e.g. (bpm) => `${bpm} BPM` */
  tempo(bpm: number): string;
  /** e.g. (n) => `${n} 小節` */
  measureCount(n: number): string;
  /** e.g. (n) => `${n} 音` */
  noteCount(n: number): string;
  /** e.g. (n) => `要確認 ${n} 件` */
  openIssues(n: number): string;
  /** Key-signature label for fifths (e.g. `ヘ長調`/`変ロ長調`…). */
  key(fifths: number, mode?: KeyMode | null): string;
}

const FIFTHS_JA: Record<string, string> = {
  "-7": "変ハ長調",
  "-6": "変ト長調",
  "-5": "変ニ長調",
  "-4": "変イ長調",
  "-3": "変ホ長調",
  "-2": "変ロ長調",
  "-1": "ヘ長調",
  "0": "ハ長調",
  "1": "ト長調",
  "2": "ニ長調",
  "3": "イ長調",
  "4": "ホ長調",
  "5": "ロ長調",
  "6": "嬰ヘ長調",
  "7": "嬰ハ長調",
};

const FIFTHS_JA_MINOR: Record<string, string> = {
  "-7": "変イ短調",
  "-6": "変ホ短調",
  "-5": "変ロ短調",
  "-4": "ヘ短調",
  "-3": "ハ短調",
  "-2": "ト短調",
  "-1": "ニ短調",
  "0": "イ短調",
  "1": "ホ短調",
  "2": "ロ短調",
  "3": "嬰ヘ短調",
  "4": "嬰ハ短調",
  "5": "嬰ト短調",
  "6": "嬰ニ短調",
  "7": "嬰イ短調",
};

export function keyLabelJa(fifths: number, mode?: KeyMode | null): string {
 const table = mode === "minor" ? FIFTHS_JA_MINOR : FIFTHS_JA;
 return table[String(fifths)] ?? `${fifths}`;
}

/** Fold a fifths count into the valid -7..+7 signature range by
 *  enharmonic projection (mirror of horn_f._fold_fifths). */
function foldFifths(fifths: number): number {
  let f = fifths;
  while (f > 7) f -= 12;
  while (f < -7) f += 12;
  return f;
}

/** #270: concert key fifths as they appear on the written Horn in F
 *  score (+1 fifth, folded) — the inspector labels the view the user
 *  is looking at, not the canonical concert document. */
export function hornWrittenFifths(concertFifths: number): number {
  return foldFifths(concertFifths + 1);
}

/** Inverse of hornWrittenFifths: a signature picked on the written
 *  score maps back to the concert fifths the engine edit expects. */
export function hornConcertFifths(writtenFifths: number): number {
  return foldFifths(writtenFifths - 1);
}

/** Parse a "n/m" meter label into raw signature parts (#129). */
export function parseMeterLabel(
  label: string | null,
): { beats: number; unit: number } | null {
  if (!label) return null;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(label.trim());
  if (!m) return null;
  const beats = Number(m[1]);
  const unit = Number(m[2]);
  if (!Number.isSafeInteger(beats) || !Number.isSafeInteger(unit)) return null;
  return { beats, unit };
}

/** Nothing-selected summary (§22 "Nothing selected" → project/score info). */
export function buildScoreInspector(
  meta: ScoreDocumentMeta,
  openIssueCount: number,
  copy: InspectorCopy,
  view: PitchViewSetting = "concert",
): ScoreInspectorModel {
  const meter = parseMeterLabel(meta.meter);
  // #270: the inspector mirrors the document the user is looking at —
  // in the written Horn in F view every signature is projected +1
  // fifth (folded), matching the score's own key display.
  const viewFifths = (f: number) =>
    view === "hornF" ? hornWrittenFifths(f) : f;
  return {
    kind: "score",
    title: meta.title,
    tempoLabel: meta.tempoBpm != null ? copy.tempo(meta.tempoBpm) : null,
    tempoBpm: meta.tempoBpm,
    meterLabel: meta.meter,
    meterBeats: meter?.beats ?? null,
    meterUnit: meter?.unit ?? null,
    // #146: with mid-piece key changes, show the transitions
    // (head key -> key at measure N) instead of just the head key.
    keyLabel:
      meta.keyChanges.length > 1
        ? meta.keyChanges
            .map((c, i) =>
              i === 0
                ? copy.key(viewFifths(c.fifths), c.mode)
                : copy.key(viewFifths(c.fifths), c.mode) + "（第" + c.measure + "小節）",
            )
            .join(" → ")
        : meta.keyFifths != null
          ? copy.key(viewFifths(meta.keyFifths), meta.keyMode)
          : null,
    keyFifths: meta.keyFifths != null ? viewFifths(meta.keyFifths) : null,
    keyMode: meta.keyMode,
    keyChangeCount: meta.keyChanges.length,
    keyChanges: meta.keyChanges.map((c) => ({
      measure: c.measure,
      fifths: viewFifths(c.fifths),
      mode: c.mode,
    })),
    measureCount: meta.measureCount,
    swingFeel: meta.swingFeel,
    measureLabel: copy.measureCount(meta.measureCount),
    noteLabel: copy.noteCount(meta.noteCount),
    openIssueLabel: copy.openIssues(openIssueCount),
  };
}

/**
 * Note-selected body (§22 "Note selected").
 *
 * `concert` / `written` are the parsed fragments of the SAME canonical note
 * in each presentation (from `notesByCanonical` of each document). The
 * written row is shown whenever the F管 presentation spells it differently,
 * so switching views never loses the context the user was reading.
 */
export function buildNoteInspector(args: {
  canonicalId: string | null;
  concert: readonly ParsedNote[];
  written: readonly ParsedNote[];
  onsetMs: number | null;
  issues: readonly ScoreReviewIssue[];
  copy: InspectorCopy;
}): NoteInspectorModel {
  const { canonicalId, concert, written, onsetMs, issues, copy } = args;
  const first = concert[0] ?? written[0];
  const measure = first?.measure ?? 0;
  const concertPitch = first ? pitchLabel(first) : "";
  const writtenPitchRaw = written[0] ? pitchLabel(written[0]) : null;
  const writtenPitch =
    writtenPitchRaw && writtenPitchRaw !== concertPitch ? writtenPitchRaw : null;

  const fragmentCount = Math.max(concert.length, written.length);
  const tied = concert.some((n) => n.tied) || written.some((n) => n.tied);
  const tieLabel = tied && fragmentCount > 1 ? copy.tieFragments(fragmentCount) : null;

  const durationLabel = first ? noteTypeJa(first) : "";
  const where = copy.measure(measure);
  const onsetLabel =
    onsetMs != null ? `${where}（${copy.scoreSeconds(onsetMs / 1000)}）` : where;

  return {
    kind: "note",
    canonicalId,
    measure,
    concertPitch,
    writtenPitch,
    durationLabel,
    onsetLabel,
    tieLabel,
    issues: issues.map((issue) => ({
      id: issue.id,
      reasonTitle: copy.review.reasonTitle(issue.reason),
      reasonDetail: copy.review.reasonDetail(issue),
      severityLabel: copy.review.severityLabel(issue.severity),
      statusLabel: copy.review.statusLabel(issue.status),
      confidencePct:
        issueConfidence(issue) != null
          ? Math.round((issueConfidence(issue) as number) * 100)
          : null,
    })),
  };
}

/** Pitch view the inspector prefers for its headline — the presentation the
 *  user is looking at leads; the other stays as secondary info. */
export function headlinePitch(
  model: NoteInspectorModel,
  view: PitchViewSetting,
): { primary: string; secondary: string | null } {
  if (view === "hornF" && model.writtenPitch) {
    return { primary: model.writtenPitch, secondary: model.concertPitch };
  }
  return { primary: model.concertPitch, secondary: model.writtenPitch };
}
