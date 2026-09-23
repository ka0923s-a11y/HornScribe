/**
 * Import-owned score-region bodies (UI-020; docs/GUI_UX_SPEC.md §3/§4/§20).
 *
 * ScoreWorkspace delegates the import-side machine states here:
 *   empty         → drop headline + 開く CTA + formats + trust + recents
 *   openingAudio  → honest indeterminate progress (§5: no fake %)
 *   audioReady    → file metadata + 採譜を開始 + 採譜オプション popover
 *   audioError    → copy-deck error card (別のファイルを選ぶ / 閉じる)
 *   sourceMissing → 元音源が見つかりません card (音源を指定 / 閉じる)
 *
 * All copy resolves through ja.import / ja.emptyState / ja.score — the
 * copy deck (protocol/copy/ja-JP.json) is the source of truth.
 */
import {
  ErrorCircle24Regular,
  FolderOpen24Regular,
  History24Regular,
  Play24Regular,
  Mic24Regular,
  Speaker2Regular,
} from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import { HsButton } from "../components/primitives/Button";
import { HsNumericField } from "../components/primitives/NumericField";
import { HsPopover } from "../components/primitives/Popover";
import { HsProgress } from "../components/primitives/Progress";
import { HsSelect, type HsSelectOption } from "../components/primitives/Select";
import type { ScreenState } from "../workspace/screen";
import { formatBytes, formatDuration } from "./format";
import type {
  ImportIssue,
  LoadedAudio,
  RecentProjectEntry,
  SourceMissingInfo,
  TranscriptionOptions,
} from "./types";
import { issueText, type CaptureState } from "../capture/controller";

/** Everything the import-owned bodies need — assembled once in App and
 *  handed down through ScoreWorkspace (keeps that shared file's diff small
 *  for the sibling feature teams). */
export interface ImportView {
  audio: LoadedAudio | null;
  openingLabel: string | null;
  openingKind: "audio" | "project" | null;
  /** AUDIO_ERROR card content (no-audio failures). */
  issue: ImportIssue | null;
  /** SOURCE_MISSING context (project + last relink outcome). */
  sourceMissing: SourceMissingInfo | null;
  recentProjects: readonly RecentProjectEntry[];
  options: TranscriptionOptions;
  onOpenAudio(): void;
  onOpenProject(entry: RecentProjectEntry): void;
  onPickRelink(): void;
  onDismissError(): void;
  onOptionsChange(next: TranscriptionOptions): void;
  /** FEAT-001 (#60): capture controls on the EMPTY state. */
  captureState?: CaptureState | null;
  onStartCapture?(source: "loopback" | "microphone"): void;
}

/** Routes the import-owned screen states to their bodies. */
export function ImportScreenBody({
  screen,
  view,
  onTranscribe,
}: {
  screen: ScreenState;
  view: ImportView;
  onTranscribe(): void;
}) {
  switch (screen) {
    case "empty":
      return <EmptyStateBody view={view} />;
    case "openingAudio":
      return <OpeningAudioBody view={view} />;
    case "audioReady":
      return <AudioReadyBody view={view} onTranscribe={onTranscribe} />;
    case "audioError":
      return <AudioErrorBody view={view} />;
    case "sourceMissing":
      return <SourceMissingBody view={view} />;
    default:
      return null;
  }
}

/* ------------------------------ EMPTY (§3) ------------------------------ */

function EmptyStateBody({ view }: { view: ImportView }) {
  return (
    <div className="hs-empty">
      <p className="hs-empty__title">{ja.emptyState.title}</p>
      <p className="hs-empty__or">{ja.emptyState.or}</p>
      <HsButton
        variant="primary"
        size="large"
        icon={<FolderOpen24Regular />}
        onClick={view.onOpenAudio}
      >
        {ja.emptyState.open}
      </HsButton>
      <p className="hs-empty__formats">{ja.emptyState.formats}</p>
      {/* FEAT-001: 録音による取り込み — ファイルを持たない入力経路。 */}
      {view.onStartCapture ? (
        <div className="hs-empty__capture">
          <p className="hs-empty__capture-title">
            {ja.emptyState.captureTitle}
          </p>
          <div className="hs-empty__capture-actions">
            <HsButton
              variant="secondary"
              icon={<Speaker2Regular />}
              disabled={view.captureState?.phase === "recording"}
              onClick={() => view.onStartCapture!("loopback")}
            >
              {ja.emptyState.captureLoopback}
            </HsButton>
            <HsButton
              variant="secondary"
              icon={<Mic24Regular />}
              disabled={view.captureState?.phase === "recording"}
              onClick={() => view.onStartCapture!("microphone")}
            >
              {ja.emptyState.captureMic}
            </HsButton>
          </div>
          <p className="hs-empty__capture-hint">
            {ja.emptyState.captureHint}
          </p>
          {/* 録音開始の失敗(デバイス無し等)はここに表示する —
              ステータス行だけでは EMPTY 画面で見落とされる。 */}
          {view.captureState?.phase === "error" &&
          view.captureState.issue ? (
            <p className="hs-empty__capture-error" role="alert">
              {issueText(view.captureState.issue)}
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="hs-empty__privacy">{ja.emptyState.privacy}</p>
      {/* §3: 履歴がある場合のみ「最近使ったプロジェクト」 */}
      {view.recentProjects.length > 0 ? (
        <div
          className="hs-recent"
          role="group"
          aria-label={ja.import.recent.title}
        >
          <p className="hs-recent__title">{ja.import.recent.title}</p>
          <ul className="hs-recent__list">
            {view.recentProjects.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="hs-recent__item"
                  title={entry.path}
                  aria-label={ja.import.recent.openAria(entry.name)}
                  onClick={() => view.onOpenProject(entry)}
                >
                  <History24Regular aria-hidden="true" />
                  <span className="hs-recent__name">{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------- OPENING_AUDIO --------------------------- */

function OpeningAudioBody({ view }: { view: ImportView }) {
  const title =
    view.openingKind === "project"
      ? ja.import.opening.project
      : ja.import.opening.audio;
  return (
    <div className="hs-empty hs-opening" role="status">
      <p className="hs-opening__title">{title}</p>
      {/* §5: indeterminate — decode time is not honestly predictable. */}
      <HsProgress label={title} className="hs-opening__progress" />
      {view.openingLabel ? (
        <p className="hs-opening__name">{view.openingLabel}</p>
      ) : null}
    </div>
  );
}

/* --------------------------- AUDIO_READY (§4) --------------------------- */

const TEMPO_OPTIONS: readonly HsSelectOption[] = [
  { value: "auto", label: ja.import.audioOptions.tempoAuto },
  { value: "manual", label: ja.import.audioOptions.tempoManual },
];
const METER_OPTIONS: readonly HsSelectOption[] = [
  { value: "4/4", label: "4/4" },
  { value: "3/4", label: "3/4" },
  { value: "6/8", label: "6/8" },
  { value: "2/4", label: "2/4" },
  { value: "5/4", label: "5/4" },
  { value: "7/8", label: "7/8" },
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
const RANGE_OPTIONS: readonly HsSelectOption[] = [
  { value: "all", label: ja.import.audioOptions.rangeAll },
  // Range selection requires a waveform selection — hidden until that
  // feature lands rather than offering a dead option.
  { value: "selection", label: ja.import.audioOptions.rangeSelection, disabled: true },
];

function AudioReadyBody({
  view,
  onTranscribe,
}: {
  view: ImportView;
  onTranscribe(): void;
}) {
  const { audio, options } = view;
  const set = (patch: Partial<TranscriptionOptions>) =>
    view.onOptionsChange({ ...options, ...patch });
  return (
    <div className="hs-empty hs-audio-ready">
      <p className="hs-score__empty-title">{ja.score.empty}</p>
      {audio ? (
        <p className="hs-audio-ready__meta">
          <span className="hs-audio-ready__name">{audio.fileName}</span>
          <span aria-hidden="true">・</span>
          <span>{audio.format.toUpperCase()}</span>
          <span aria-hidden="true">・</span>
          <span>{formatDuration(audio.durationSeconds)}</span>
          <span aria-hidden="true">・</span>
          <span>{formatBytes(audio.sizeBytes)}</span>
        </p>
      ) : null}
      <div className="hs-audio-ready__actions">
        <HsButton
          variant="primary"
          size="large"
          icon={<Play24Regular />}
          onClick={onTranscribe}
        >
          {ja.score.transcribeStart}
        </HsButton>
        {/* §4: advanced transcription settings live in the popover next to
            the primary action — hidden by default. */}
        <HsPopover
          ariaLabel={ja.import.audioOptions.label}
          positioning="above"
          trigger={
            <HsButton variant="subtle">
              {ja.import.audioOptions.label}
            </HsButton>
          }
        >
          <div className="hs-audio-options">
            <p className="hs-audio-options__title">
              {ja.import.audioOptions.label}
            </p>
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
                onChange={(v) => set({ tempoBpm: v })}
              />
            ) : null}
            <HsSelect
              label={ja.import.audioOptions.meter}
              options={METER_OPTIONS}
              value={options.meter}
              onChange={(v) => set({ meter: v })}
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
          </div>
        </HsPopover>
      </div>
    </div>
  );
}

/* ------------------------------ errors (§20) ------------------------------ */

/** Copy-deck error copy per issue kind — shared by the AUDIO_ERROR card
 *  and the modal dialog shown when a re-import fails over a live session. */
export function issueCopy(issue: ImportIssue): {
  title: string;
  body: string;
  fileName?: string;
} {
  switch (issue.kind) {
    case "unsupported":
      return {
        title: ja.import.errors.unsupportedTitle,
        body: ja.import.errors.unsupportedBody,
        fileName: issue.fileName,
      };
    case "openFailed":
      return {
        title: ja.import.errors.openFailedTitle,
        body: ja.import.errors.openFailedBody,
        fileName: issue.fileName,
      };
    case "projectOpenFailed":
      return {
        title: ja.import.errors.projectOpenFailedTitle,
        body: ja.import.errors.projectOpenFailedBody,
        fileName: issue.fileName,
      };
  }
}

function AudioErrorBody({ view }: { view: ImportView }) {
  const issue = view.issue ?? { kind: "openFailed" as const };
  const copy = issueCopy(issue);
  const canPickAnother = issue.kind !== "projectOpenFailed";
  return (
    <div className="hs-empty hs-error" role="alert">
      <ErrorCircle24Regular
        className="hs-error__icon"
        aria-hidden="true"
      />
      <p className="hs-error__title">{copy.title}</p>
      {copy.fileName ? (
        <p className="hs-error__file">{copy.fileName}</p>
      ) : null}
      <p className="hs-error__body">{copy.body}</p>
      <div className="hs-error__actions">
        {canPickAnother ? (
          <HsButton variant="primary" onClick={view.onOpenAudio}>
            {ja.import.errors.chooseAnother}
          </HsButton>
        ) : null}
        <HsButton
          variant={canPickAnother ? "secondary" : "primary"}
          onClick={view.onDismissError}
        >
          {ja.import.errors.close}
        </HsButton>
      </div>
    </div>
  );
}

function SourceMissingBody({ view }: { view: ImportView }) {
  const info = view.sourceMissing;
  const mismatch = info?.mismatch === true;
  return (
    <div className="hs-empty hs-error" role="alert">
      <ErrorCircle24Regular
        className="hs-error__icon"
        aria-hidden="true"
      />
      <p className="hs-error__title">
        {mismatch
          ? ja.import.errors.hashMismatchTitle
          : ja.import.errors.sourceMissingTitle}
      </p>
      {info?.project.sourcePath ? (
        <p className="hs-error__file" title={info.project.sourcePath}>
          {ja.import.errors.lastLocation}
          {info.project.sourcePath}
        </p>
      ) : null}
      <p className="hs-error__body">
        {mismatch
          ? ja.import.errors.hashMismatchBody
          : ja.import.errors.sourceMissingBody}
      </p>
      <div className="hs-error__actions">
        <HsButton variant="primary" onClick={view.onPickRelink}>
          {mismatch
            ? ja.import.errors.specifyAnother
            : ja.import.errors.specifySource}
        </HsButton>
        <HsButton variant="secondary" onClick={view.onDismissError}>
          {ja.import.errors.close}
        </HsButton>
      </div>
    </div>
  );
}
