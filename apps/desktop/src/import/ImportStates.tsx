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
  Dismiss16Regular,
  ErrorCircle24Regular,
  FolderOpen24Regular,
  DocumentBulletList24Regular,
  History24Regular,
  Play24Regular,
  Mic24Regular,
  Speaker2Regular,
} from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import { HsButton } from "../components/primitives/Button";
import { HsPopover } from "../components/primitives/Popover";
import { HsProgress } from "../components/primitives/Progress";
import type { ScreenState } from "../workspace/screen";
import { formatBytes, formatDuration } from "./format";
import { TranscriptionOptionsFields } from "./TranscriptionOptionsFields";
import { invalidSelectionRange } from "./transcriptionParams";
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
  // #369: dedicated project picker — the EMPTY screen offers it as a
  // secondary action so resuming saved work never hides inside the
  // audio picker's all-files escape hatch.
  onPickProject(): void;
  onOpenProject(entry: RecentProjectEntry): void;
  /** #364: 履歴から削除 — drops the path from the MRU (list entries and
   *  the projectOpenFailed card both use it). Never touches the file. */
  onRemoveRecent(path: string): void;
  onPickRelink(): void;
  onDismissError(): void;
  onOptionsChange(next: TranscriptionOptions): void;
  /** #18: 現在の音源+オプション(選択範囲を含む)を採譜キューに積む。
   *  範囲を変えて連打すれば複数区間の逐次採譜になる。 */
  onEnqueueQueue?(): void;
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
      {/* #369: secondary project-open affordance — quiet next to the
          audio CTA, but always reachable from EMPTY; sits below the
          formats note so that hint stays coupled to the audio path. */}
      <HsButton
        variant="secondary"
        icon={<DocumentBulletList24Regular />}
        onClick={view.onPickProject}
      >
        {ja.emptyState.openProject}
      </HsButton>
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
      <RecentProjectList view={view} />
    </div>
  );
}

/* --------------------------- OPENING_AUDIO --------------------------- */

/** §3 recents list — per-row 履歴から削除 (#364); duplicate names get a
 *  parent-dir subline so same-named projects stay distinguishable. Rows
 *  are plain <button>s: keyboard focus + Enter/Space just work. */
function RecentProjectList({ view }: { view: ImportView }) {
  if (view.recentProjects.length === 0) return null;
  const nameCounts = new Map<string, number>();
  for (const e of view.recentProjects) {
    nameCounts.set(e.name, (nameCounts.get(e.name) ?? 0) + 1);
  }
  return (
    <div
      className="hs-recent"
      role="group"
      aria-label={ja.import.recent.title}
    >
      <p className="hs-recent__title">{ja.import.recent.title}</p>
      <ul className="hs-recent__list">
        {view.recentProjects.map((entry) => {
          const dir =
            (nameCounts.get(entry.name) ?? 0) > 1
              ? parentDir(entry.path)
              : null;
          return (
            <li key={entry.path} className="hs-recent__row">
              <button
                type="button"
                className="hs-recent__item"
                title={entry.path}
                aria-label={ja.import.recent.openAria(entry.name)}
                onClick={() => view.onOpenProject(entry)}
              >
                <History24Regular aria-hidden="true" />
                <span className="hs-recent__text">
                  <span className="hs-recent__name">{entry.name}</span>
                  {dir ? (
                    <span className="hs-recent__dir">{dir}</span>
                  ) : null}
                </span>
              </button>
              <button
                type="button"
                className="hs-recent__remove"
                title={ja.import.recent.removeTitle}
                aria-label={ja.import.recent.removeAria(entry.name)}
                onClick={() => view.onRemoveRecent(entry.path)}
              >
                <Dismiss16Regular aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Containing directory of an MRU path (either separator) — rendered
 *  only when two entries share a name (#364 disambiguation). */
function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : "";
}

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

function AudioReadyBody({
  view,
  onTranscribe,
}: {
  view: ImportView;
  onTranscribe(): void;
}) {
  const { audio, options } = view;
  // #346: an empty/inverted 選択範囲 is a field error, not a silent
  // switch to 全曲採譜 — the field shows the message and 採譜を開始
  // stays disabled until the pair is valid again (a waveform drag or
  // corrected numbers both clear it live).
  const rangeInvalid = invalidSelectionRange(
    options,
    audio?.durationSeconds ?? 0,
  );
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
          disabled={rangeInvalid}
          onClick={onTranscribe}
        >
          {ja.score.transcribeStart}
        </HsButton>
        {/* #18: 開始せずキューに積む — 複数ファイル/複数区間を連続で
            回すときの入口。選択範囲もそのまま params に焼き付く。 */}
        {view.onEnqueueQueue ? (
          <HsButton
            variant="secondary"
            disabled={rangeInvalid}
            onClick={() => view.onEnqueueQueue?.()}
          >
            {ja.queue.addCurrent}
          </HsButton>
        ) : null}
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
          <TranscriptionOptionsFields
            options={options}
            durationSec={audio?.durationSeconds ?? 0}
            onChange={view.onOptionsChange}
            title={ja.import.audioOptions.label}
          />
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
  const removablePath =
    issue.kind === "projectOpenFailed" ? issue.path : undefined;
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
        {/* The shared picker routes .hornscribe.json back to
            openProject, so this doubles as "open another project" —
            shown on projectOpenFailed too (#364). */}
        <HsButton variant="primary" onClick={view.onOpenAudio}>
          {ja.import.errors.chooseAnother}
        </HsButton>
        {removablePath ? (
          <HsButton
            variant="secondary"
            onClick={() => {
              // One click resolves the dead MRU entry: remove, then
              // close back to the (already refreshed) recent list.
              view.onRemoveRecent(removablePath);
              view.onDismissError();
            }}
          >
            {ja.import.errors.removeFromRecent}
          </HsButton>
        ) : null}
        <HsButton
          variant="secondary"
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
