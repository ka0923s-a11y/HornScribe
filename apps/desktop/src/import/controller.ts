/**
 * Import flow controller (UI-020 / issue #25; docs/GUI_UX_SPEC.md §3/§4/§20).
 *
 * Framework-free: App subscribes to state + screen events; tests drive it
 * with fake ports. The controller owns the §27 import-side transitions —
 *
 *   EMPTY ─pick/drop→ OPENING_AUDIO ─ok→ AUDIO_READY
 *                         ├─ unsupported/corrupt → AUDIO_ERROR ─閉じる→ EMPTY
 *                         └─ (audio already loaded: error surfaces as a
 *                             dialog issue over the kept workspace)
 *   recent project ─→ OPENING_AUDIO ─source ok→ AUDIO_READY
 *                         └─ path/hash failure → SOURCE_MISSING
 *                                └─ 音源を指定 → hash ok → AUDIO_READY
 *                                                mismatch → SOURCE_MISSING
 *
 * Error policy (§20): state what failed, what is kept, the next action —
 * a failed re-import never destroys a loaded audio session, and the source
 * file is only ever read (FND-001: identity = content hash, not location).
 */
import type { ScreenState } from "../workspace/screen";
import { ja } from "../strings/ja";
import { type ImportPorts } from "./ports";
import { audioFormatOf, baseName, projectDisplayName } from "./formats";
import {
  markAutoOpenFailed,
  recordRecentProject,
  loadRecentProjects,
} from "./recentProjects";
import { parseRegionLabels } from "../workspace/regionLabels";
import type {
  AudioFileRef,
  AudioFormat,
  ImportIssue,
  LoadedAudio,
  MediaSource,
  ProjectSummary,
  RecentProjectEntry,
  RecordedAudioRef,
  SourceMissingInfo,
} from "./types";

export type ImportPhase =
  "idle" | "opening" | "ready" | "error" | "sourceMissing";

export interface ImportState {
  readonly phase: ImportPhase;
  /** File/project name shown while `phase === "opening"`. */
  readonly openingLabel: string | null;
  /** "audio" | "project" selects the loading copy variant. */
  readonly openingKind: "audio" | "project" | null;
  readonly audio: LoadedAudio | null;
  /** Recoverable failure — card content on AUDIO_ERROR, dialog content
      when the workspace already has audio (the error never destroys it). */
  readonly issue: ImportIssue | null;
  readonly sourceMissing: SourceMissingInfo | null;
}

export const INITIAL_IMPORT_STATE: ImportState = {
  phase: "idle",
  openingLabel: null,
  openingKind: null,
  audio: null,
  issue: null,
  sourceMissing: null,
};

export interface ImportEvents {
  /** Screen transitions owned by the import flow (§27). */
  onScreenChange(screen: ScreenState): void;
  /** Mirrors state for React consumers. */
  onState(state: ImportState): void;
  /** aria-live status bar announcements (role="status"). */
  announce(message: string): void;
  /** Recent-projects list changed (persisted + UI). */
  onRecentChange(entries: readonly RecentProjectEntry[]): void;
  /** Decoded audio is ready — host wires it into the transport adapter. */
  onAudioReady(audio: LoadedAudio): void;
  /** Optional (#106): the opened project carried a saved score — the
   *  host restores it and jumps to SCORE_READY instead of waiting for
   *  a re-transcription. Fires after the usual state/screen updates. */
  onProjectScoreReady?(
    result: unknown,
    project: {
      projectId: string;
      /** #221: the .hornscribe.json this score came from — the host's
       *  Ctrl+S saves back to it without re-picking a path. */
      path: string;
      sourceHash: string | null;
      // #265: the recorded source path — the host keeps it so a
      // SOURCE_MISSING save preserves the relink target.
      sourcePath: string | null;
      /** #391: the project document came from the `.recovery` sibling
       *  — the host keeps the restored doc dirty so the next save
       *  repairs the unreadable main file. */
      recovered?: boolean;
      /** #12: the saved 区間ラベル extras — the host restores them
       *  and seeds the clean baseline with the same set. */
      regionLabels?: readonly {
        id: string;
        label: string;
        startSec: number;
        endSec: number;
      }[];
    },
  ): void;
  /** Optional (#264): a project document was opened (or relinked) —
   *  fires before onAudioReady so the host can restore the saved
   *  transcription settings into 採譜オプション before the audio
   *  slot resets them to global defaults. */
  onProjectOpened?(project: ProjectSummary): void;
  /** #367: a SOURCE_MISSING relink verified — audio reattached, the
   *  live ScoreDocument kept. The summary's `sourcePath` is the new
   *  verified location: the host updates its source ref and marks the
   *  project dirty so the path change reaches the file on save. */
  onProjectRelinked?(project: ProjectSummary): void;
}

type RecentStorage = Pick<Storage, "getItem" | "setItem"> | null;

export class ImportController {
  private state: ImportState = INITIAL_IMPORT_STATE;
  /** Serialization guard: a superseded open (user re-picked mid-load) must
      not overwrite newer state when it resolves late. */
  private generation = 0;

  constructor(
    private readonly ports: ImportPorts,
    private readonly events: ImportEvents,
    private readonly storage: RecentStorage = null,
  ) {}

  getState(): ImportState {
    return this.state;
  }

  /** `file.openAudio` (Ctrl+O / 開く / drop fallback): pick then import. */
  async openViaDialog(): Promise<void> {
    let ref: AudioFileRef | null;
    try {
      ref = await this.ports.pickAudio();
    } catch {
      // A picker failure is not a file error — surface the generic
      // open-failure issue rather than an unhandled rejection.
      this.fail({ kind: "openFailed" });
      return;
    }
    if (!ref) return; // cancel is silent — not an error
    await this.importRefs([ref]);
  }

  // #369: `file.openProject` (Ctrl+Shift+O / プロジェクトを開く) —
  // the dedicated picker. A picked file always takes the project-open
  // funnel (migrate + validate + source verify); a non-project JSON
  // surfaces the honest projectOpenFailed card rather than guessing.
  async openProjectViaDialog(): Promise<void> {
    let ref: AudioFileRef | null;
    try {
      ref = await this.ports.pickProject();
    } catch {
      // A picker failure is not a file error — surface the generic
      // open-failure issue rather than an unhandled rejection.
      this.fail({ kind: "openFailed" });
      return;
    }
    if (!ref) return; // cancel is silent — not an error
    const bytes = ref.kind === "file" ? ref.file : undefined;
    await this.openProject(
      {
        name: projectDisplayName(ref.name),
        path: ref.kind === "path" ? ref.path : "",
        openedAt: Date.now(),
      },
      bytes,
    );
  }

  /**
   * Drag&drop / dialog entry point. With several files the first supported
   * one wins (single-document app); zero supported → honest format error.
   */
  async importRefs(refs: readonly AudioFileRef[]): Promise<void> {
    if (refs.length === 0) return;
    // #348: single-document app — when several files arrive, say so
    // instead of silently taking the first supported one.
    if (refs.length > 1) {
      this.events.announce(ja.import.feedback.multiFileNotice);
    }
    // A dropped/picked .hornscribe.json is a project open, not an audio
    // import — the dialog's "all files" escape hatch can hand one over.
    const projRef = refs.find((r) => r.name.endsWith(".hornscribe.json"));
    if (projRef) {
      const bytes = projRef.kind === "file" ? projRef.file : undefined;
      await this.openProject(
        {
          name: projectDisplayName(projRef.name),
          path: projRef.kind === "path" ? projRef.path : "",
          openedAt: Date.now(),
        },
        bytes,
      );
      return;
    }
    const ref = refs.find((r) => audioFormatOf(r.name) !== null) ?? refs[0];
    const format = audioFormatOf(ref.name);
    if (format === null) {
      this.fail({ kind: "unsupported", fileName: ref.name });
      return;
    }
    await this.importAudioRef(ref, format);
  }

  /**
   * FEAT-001 (#60): 録音バッファを直接取り込む(PC音源/マイク録音)。
   * `ref` は `kind:"recording"` で、`blob` は WAV または MediaRecorder
   * 出力(ブラウザ dev)。拡張子は常に `.wav`/`.webm` を仮定するため
   * `audioFormatOf` の allowlist を迂回して良い(録音由来なので形式は
   * 自明)。失敗時は openFailed に落とす。
   */
  async importRecording(ref: RecordedAudioRef): Promise<void> {
    const gen = this.begin("audio", ref.name);
    try {
      // #230: a persisted recording probes natively — no byte copy,
      // playback streams via media://.
      const probe =
        ref.path && this.ports.probeAudio
          ? await this.ports.probeAudio(ref.path)
          : null;
      if (!this.isCurrent(gen)) return;
      if (probe) {
        const audio: LoadedAudio = {
          ref: { ...ref, contentHash: probe.contentHash },
          fileName: ref.name,
          format: "wav",
          sizeBytes: probe.sizeBytes,
          durationSeconds: probe.durationSeconds,
          sampleRate: probe.sampleRate,
          peaks: probe.peaks,
          mediaSource: { kind: "url", url: probe.playbackUrl },
        };
        this.setState({
          phase: "ready",
          openingLabel: null,
          openingKind: null,
          audio,
          issue: null,
          sourceMissing: null,
        });
        this.events.onAudioReady(audio);
        this.events.announce(
          ref.source === "loopback"
            ? ja.import.feedback.capturedLoopback(ref.name)
            : ja.import.feedback.capturedMic(ref.name),
        );
        return;
      }
      // Tauri 録音は保存済みファイルを読む(#70: 実ファイル=リリンク可能)。
      const blob = ref.blob ?? (await this.ports.readAudioBytes(ref.path!));
      const contentHash = ref.path
        ? await this.ports.sha256Hex(blob)
        : undefined;
      const decoded = await this.ports.decodeAudio(blob, ref.name);
      if (!this.isCurrent(gen)) return;
      const audio: LoadedAudio = {
        ref: { ...ref, contentHash },
        fileName: ref.name,
        // 録音物は decode 可能なコンテナなので拡張子は実質 wav。
        format: "wav",
        sizeBytes: blob.size,
        durationSeconds: decoded.durationSeconds,
        sampleRate: decoded.sampleRate,
        peaks: decoded.peaks,
        mediaSource: { kind: "blob", blob },
      };
      this.setState({
        phase: "ready",
        openingLabel: null,
        openingKind: null,
        audio,
        issue: null,
        sourceMissing: null,
      });
      this.events.onAudioReady(audio);
      this.events.announce(
        ref.source === "loopback"
          ? ja.import.feedback.capturedLoopback(ref.name)
          : ja.import.feedback.capturedMic(ref.name),
      );
    } catch {
      if (!this.isCurrent(gen)) return;
      this.fail({ kind: "openFailed", fileName: ref.name });
    }
  }

  /** OPENING_AUDIO → AUDIO_READY, or AUDIO_ERROR. */
  private async importAudioRef(
    ref: AudioFileRef,
    format: AudioFormat,
  ): Promise<void> {
    const gen = this.begin("audio", ref.name);
    try {
      // #230: path-backed sources probe natively — hash/metadata/peaks
      // in Rust, playback streamed via media:// — so the file's bytes
      // never enter the webview. kind:"file" refs and probe failures
      // keep the byte path.
      const probe =
        ref.kind === "path" && this.ports.probeAudio
          ? await this.ports.probeAudio(ref.path)
          : null;
      if (!this.isCurrent(gen)) return;
      if (probe) {
        const audio: LoadedAudio = {
          ref: { ...ref, contentHash: probe.contentHash },
          fileName: ref.name,
          format,
          sizeBytes: probe.sizeBytes,
          durationSeconds: probe.durationSeconds,
          sampleRate: probe.sampleRate,
          peaks: probe.peaks,
          mediaSource: { kind: "url", url: probe.playbackUrl },
        };
        this.setState({
          phase: "ready",
          openingLabel: null,
          openingKind: null,
          audio,
          issue: null,
          sourceMissing: null,
        });
        this.events.onAudioReady(audio);
        this.events.announce(ja.import.feedback.loaded(ref.name));
        return;
      }
      const blob = await this.blobFor(ref);
      // #243: the content hash is the source identity (FND-001) —
      // computing it once at import lets project save write a real
      // contentHash instead of the empty string that broke reopen.
      const contentHash = await this.ports.sha256Hex(blob);
      const decoded = await this.ports.decodeAudio(blob, ref.name);
      if (!this.isCurrent(gen)) return;
      const audio: LoadedAudio = {
        ref: { ...ref, contentHash },
        fileName: ref.name,
        format,
        sizeBytes: blob.size,
        durationSeconds: decoded.durationSeconds,
        sampleRate: decoded.sampleRate,
        peaks: decoded.peaks,
        mediaSource: { kind: "blob", blob },
      };
      this.setState({
        phase: "ready",
        openingLabel: null,
        openingKind: null,
        audio,
        issue: null,
        sourceMissing: null,
      });
      this.events.onAudioReady(audio);
      this.events.announce(ja.import.feedback.loaded(ref.name));
    } catch {
      if (!this.isCurrent(gen)) return;
      this.fail({ kind: "openFailed", fileName: ref.name });
    }
  }

  /**
   * 最近使ったプロジェクト → verify the recorded source path (store.py
   * `verify_source_audio`: exists + content hash) → AUDIO_READY, else
   * SOURCE_MISSING with the relink action.
   * `bytes` carries a browser-dev File ref (no durable path — the
   * project is opened but not recorded in the recents list).
   */
  async openProject(entry: RecentProjectEntry, bytes?: Blob): Promise<void> {
    const gen = this.begin("project", entry.name);
    try {
      // #365: when the engine-backed inspector is wired, the document is
      // migrated + validated by `project.open` (same funnel as
      // project.save); the lighter local parser remains only as the
      // no-engine browser-dev fallback.
      const { document: data, recovered } = bytes
        ? await this.projectDocumentFromBytes(bytes)
        : await this.projectDocumentFromPath(entry.path);
      // Browser-dev File refs have no durable path — project.path
      // stays "" so touchRecent skips them; the display name comes
      // from the file name instead.
      const project = projectSummaryFromDocument(
        data,
        entry.path,
        entry.path ? undefined : entry.name,
        recovered,
      );
      // #147: record the project's sourceAudio ref into the persistent
      // index — survives MRU truncation, covers SOURCE_MISSING opens too
      // (the project file still references the source until re-saved).
      // #221: byte-opened projects (autosave restore, browser File
      // drops) have no durable path — indexing an empty key would
      // pollute the source-ref store.
      if (project.path) {
        this.ports.updateSourceRef?.(project.path, project.sourcePath);
      }
      if (!this.isCurrent(gen)) return;
      if (!project.sourcePath || !project.sourceHash) {
        this.enterSourceMissing(project, false);
        return;
      }
      // #230: probe the recorded source natively — hash verify +
      // metadata/peaks + media:// playback, with zero bytes in the
      // webview. Probe failure falls back to the byte path below.
      if (this.ports.probeAudio) {
        const probe = await this.ports.probeAudio(project.sourcePath);
        if (!this.isCurrent(gen)) return;
        if (probe) {
          if (probe.contentHash !== project.sourceHash) {
            // File at the recorded path exists but content differs —
            // store.py treats this like a moved source (verify fails).
            this.enterSourceMissing(project, false);
            return;
          }
          this.finishProjectOpen(
            project,
            {
              kind: "path",
              path: project.sourcePath,
              name: baseName(project.sourcePath),
            },
            {
              sizeBytes: probe.sizeBytes,
              durationSeconds: probe.durationSeconds,
              sampleRate: probe.sampleRate,
              peaks: probe.peaks,
              mediaSource: { kind: "url", url: probe.playbackUrl },
            },
          );
          return;
        }
      }
      let audioBlob: Blob;
      try {
        audioBlob = await this.ports.readAudioBytes(project.sourcePath);
      } catch {
        if (!this.isCurrent(gen)) return;
        this.enterSourceMissing(project, false);
        return;
      }
      const hash = await this.ports.sha256Hex(audioBlob);
      if (!this.isCurrent(gen)) return;
      if (hash !== project.sourceHash) {
        // File at the recorded path exists but content differs —
        // store.py treats this like a moved source (verify fails).
        this.enterSourceMissing(project, false);
        return;
      }
      try {
        const decoded = await this.ports.decodeAudio(audioBlob, entry.name);
        if (!this.isCurrent(gen)) return;
        this.finishProjectOpen(
          project,
          {
            kind: "path",
            path: project.sourcePath,
            name: baseName(project.sourcePath),
          },
          {
            sizeBytes: audioBlob.size,
            durationSeconds: decoded.durationSeconds,
            sampleRate: decoded.sampleRate,
            peaks: decoded.peaks,
            mediaSource: { kind: "blob", blob: audioBlob },
          },
        );
      } catch {
        if (!this.isCurrent(gen)) return;
        this.fail({
          kind: "openFailed",
          fileName: baseName(project.sourcePath),
        });
      }
    } catch {
      if (!this.isCurrent(gen)) return;
      // #364: a failed open marks the path so the launch auto-open
      // cannot error-loop on the same dead MRU head every start; the
      // path rides the issue so the error card can offer 履歴から削除.
      if (entry.path) markAutoOpenFailed(entry.path);
      this.fail({
        kind: "projectOpenFailed",
        fileName: entry.name,
        path: entry.path || undefined,
      });
    }
  }

  /** SOURCE_MISSING: 「音源を指定」 — pick a candidate then verify. */
  async pickRelinkSource(): Promise<void> {
    let ref: AudioFileRef | null;
    try {
      ref = await this.ports.pickAudio();
    } catch {
      // Picker failure while relinking — stay on the SOURCE_MISSING card
      // and say what happened; the user can retry 音源を指定.
      this.events.announce(ja.import.errors.openFailedBody);
      return;
    }
    if (!ref) return;
    await this.relinkWith(ref);
  }

  /**
   * Hash-based relink, the same contract as
   * `ProjectStore.relink_source_audio`: the candidate must hash to the
   * recorded content hash — identity is content, not location.
   */
  async relinkWith(ref: AudioFileRef): Promise<void> {
    const sm = this.state.sourceMissing;
    if (!sm) return;
    const gen = this.begin("project", sm.project.name);
    try {
      // #230: a path-backed candidate verifies + probes natively — the
      // bytes never enter the webview; kind:"file" and probe failures
      // keep the byte path.
      if (ref.kind === "path" && this.ports.probeAudio) {
        const probe = await this.ports.probeAudio(ref.path);
        if (!this.isCurrent(gen)) return;
        if (probe) {
          if (probe.contentHash !== sm.project.sourceHash) {
            // #367: retry card only — the live score stays put.
            this.enterSourceMissing(sm.project, true, false);
            return;
          }
          const format = audioFormatOf(ref.name) ?? "wav";
          const audio: LoadedAudio = {
            // #234: the verified project hash is the audio identity.
            ref: { ...ref, contentHash: sm.project.sourceHash ?? probe.contentHash },
            fileName: ref.name,
            format,
            sizeBytes: probe.sizeBytes,
            durationSeconds: probe.durationSeconds,
            sampleRate: probe.sampleRate,
            peaks: probe.peaks,
            mediaSource: { kind: "url", url: probe.playbackUrl },
          };
          this.finishRelink(sm.project, audio);
          return;
        }
      }
      const blob = await this.blobFor(ref);
      const hash = await this.ports.sha256Hex(blob);
      if (!this.isCurrent(gen)) return;
      if (hash !== sm.project.sourceHash) {
        // #367: retry card only — the live score stays put.
        this.enterSourceMissing(sm.project, true, false);
        return;
      }
      const decoded = await this.ports.decodeAudio(blob, ref.name);
      if (!this.isCurrent(gen)) return;
      const format = audioFormatOf(ref.name) ?? "wav";
      const audio: LoadedAudio = {
        // #234: carry the verified hash so the audio identity matches
        // the project's recorded sourceHash — a relinked source
        // keeps its restored score instead of invalidating it.
        ref: { ...ref, contentHash: sm.project.sourceHash ?? hash },
        fileName: ref.name,
        format,
        sizeBytes: blob.size,
        durationSeconds: decoded.durationSeconds,
        sampleRate: decoded.sampleRate,
        peaks: decoded.peaks,
        mediaSource: { kind: "blob", blob },
      };
      this.finishRelink(sm.project, audio);
    } catch {
      if (!this.isCurrent(gen)) return;
      // Candidate unreadable or undecodable after a hash match — stay on
      // the missing-source card; the status line carries what happened
      // (the card itself already offers the retry action).
      this.enterSourceMissing(sm.project, false, false);
      this.events.announce(ja.import.errors.openFailedBody);
    }
  }

  /** Relink success tail — shared by the native-probe and byte paths. */
  private finishRelink(project: ProjectSummary, audio: LoadedAudio): void {
    this.setState({
      phase: "ready",
      openingLabel: null,
      openingKind: null,
      audio,
      issue: null,
      sourceMissing: null,
    });
    this.touchRecent(project);
    // #264: relink resumes the same project — restore its saved
    // 採譜 settings before the audio slot resets options.
    /* #367: the relink attaches audio ONLY — re-firing
     * onProjectScoreReady would rebuild the ScoreDocument from the
     * file's saved extras and silently discard unsaved edits, review
     * decisions and the undo stack. The live document already holds
     * the restored score (enterSourceMissing fired it), so the
     * verified new source path is the only project change here. */
    const relinkedProject: ProjectSummary = {
      ...project,
      sourcePath:
        audio.ref.kind === "path" ? audio.ref.path : project.sourcePath,
    };
    this.events.onProjectOpened?.(relinkedProject);
    this.events.onAudioReady(audio);
    // The recordings-prune index tracks the path the session actually
    // uses now; the project file itself catches up on the next save
    // (the relinked audio ref is what the save serializes).
    if (project.path) {
      this.ports.updateSourceRef?.(project.path, relinkedProject.sourcePath);
    }
    // The host marks the source-path change dirty — a close without a
    // save would otherwise land back on SOURCE_MISSING next launch.
    this.events.onProjectRelinked?.(relinkedProject);
    // #391: the restore notice outranks the routine relink one.
    this.announceOpened(project, ja.import.feedback.sourceRelinked);
  }

  /** 閉じる on AUDIO_ERROR / SOURCE_MISSING → EMPTY; on a kept workspace
      (issue dialog over audio) it only clears the issue. */
  dismiss(): void {
    if (this.state.phase === "error" || this.state.phase === "sourceMissing") {
      this.setState({ ...INITIAL_IMPORT_STATE });
      return;
    }
    if (this.state.issue) {
      this.setState({ ...this.state, issue: null });
    }
  }

  /** Recent entries (host renders them in the EMPTY state). */
  recentProjects(): RecentProjectEntry[] {
    return loadRecentProjects(this.storage);
  }

  /* ----------------------------- internals ----------------------------- */

  private begin(kind: "audio" | "project", label: string): number {
    const gen = ++this.generation;
    this.setState({
      phase: "opening",
      openingLabel: label,
      openingKind: kind,
      audio: this.state.audio,
      issue: null,
      sourceMissing: null,
    });
    return gen;
  }

  private isCurrent(gen: number): boolean {
    return gen === this.generation;
  }

  /** `project.open` by path — the worker reads the file itself, so no
   *  bytes cross the webview. Falls back to the local parser where no
   *  engine exists (browser dev). */
  private async projectDocumentFromPath(
    path: string,
  ): Promise<{ document: Record<string, unknown>; recovered: boolean }> {
    const inspect = this.ports.inspectProject;
    if (inspect) {
      const res = await inspect({ path });
      // #391: `recovered` marks a .recovery-sibling restore — the
      // browser-dev parser has no such sibling so it stays false.
      return { document: res.project, recovered: res.recovered === true };
    }
    const blob = await this.ports.readProjectBytes(path);
    return {
      document: parseProjectJson(await blob.arrayBuffer()),
      recovered: false,
    };
  }

  /** `project.open` by bytes — File drops and autosave snapshots ride
   *  `documentBase64` so they take the identical migrate+validate path
   *  as a disk open (#365 acceptance). */
  private async projectDocumentFromBytes(
    bytes: Blob,
  ): Promise<{ document: Record<string, unknown>; recovered: boolean }> {
    const inspect = this.ports.inspectProject;
    if (inspect) {
      const res = await inspect({
        documentBase64: await blobToBase64(bytes),
      });
      // Byte-opens have no durable path — there is no .recovery
      // sibling to restore from, so a success is never `recovered`.
      return { document: res.project, recovered: false };
    }
    return { document: parseProjectJson(await bytes.arrayBuffer()), recovered: false };
  }

  private fail(issue: ImportIssue): void {
    if (this.state.audio) {
      // Workspace is alive — the issue becomes a dialog over it, the
      // loaded audio/waveform/transport all stay (§20 "what is kept").
      this.setState({ ...this.state, phase: "ready", issue });
    } else {
      this.setState({
        phase: "error",
        openingLabel: null,
        openingKind: null,
        audio: null,
        issue,
        sourceMissing: null,
      });
    }
  }

  private enterSourceMissing(
    project: ProjectSummary,
    mismatch: boolean,
    /* #367: a relink retry re-enters this state with the live
     * ScoreDocument already on screen — re-firing the saved extras
     * would clobber unsaved edits, so retries pass restoreScore=false. */
    restoreScore = true,
  ): void {
    this.setState({
      phase: "sourceMissing",
      openingLabel: null,
      openingKind: null,
      audio: null,
      issue: null,
      sourceMissing: { project, mismatch },
    });
    // #106: the score survives a missing/moved source — restore it
    // now; the audio can be relinked afterwards.
    if (restoreScore && project.scoreResult != null) {
      this.events.onProjectScoreReady?.(project.scoreResult, {
        projectId: project.projectId,
        path: project.path,
        sourceHash: project.sourceHash,
        sourcePath: project.sourcePath,
        recovered: project.recovered,
        regionLabels: project.regionLabels,
      });
    }
    // #391: a .recovery restore has no card of its own — the status
    // line carries the notice alongside the SOURCE_MISSING card.
    if (project.recovered) {
      this.events.announce(ja.import.feedback.projectRecovered(project.name));
    }
  }

  private finishProjectOpen(
    project: ProjectSummary,
    ref: AudioFileRef,
    media: {
      sizeBytes: number;
      durationSeconds: number;
      sampleRate: number;
      peaks: readonly number[];
      mediaSource: MediaSource;
    },
  ): void {
    const format = audioFormatOf(ref.name) ?? "wav";
    const audio: LoadedAudio = {
      // #234: the recorded project hash is this audio's verified
      // content identity — carry it so identity checks line up.
      ref: { ...ref, contentHash: project.sourceHash ?? undefined },
      fileName: ref.name,
      format,
      sizeBytes: media.sizeBytes,
      durationSeconds: media.durationSeconds,
      sampleRate: media.sampleRate,
      peaks: media.peaks,
      mediaSource: media.mediaSource,
    };
    this.setState({
      phase: "ready",
      openingLabel: null,
      openingKind: null,
      audio,
      issue: null,
      sourceMissing: null,
    });
    this.touchRecent(project);
    // #264: restore the saved 採譜 settings before the host's audio
    // slot logic runs — 採譜し直す must default to the conditions
    // that produced this project, not current global defaults.
    this.events.onProjectOpened?.(project);
    this.events.onAudioReady(audio);
    // #106: a project saved with score extras skips re-transcription —
    // the host restores the document and lands on SCORE_READY.
    if (project.scoreResult != null) {
      this.events.onProjectScoreReady?.(project.scoreResult, {
        projectId: project.projectId,
        path: project.path,
        sourceHash: project.sourceHash,
        sourcePath: project.sourcePath,
        recovered: project.recovered,
        regionLabels: project.regionLabels,
      });
      this.announceOpened(project);
    } else {
      // #391: even a score-less restore must surface the recovery —
      // the user needs to know the main file is broken.
      this.announceOpened(project, ja.import.feedback.loaded(ref.name));
    }
  }

  /** Project-open announce — a `.recovery` restore overrides the usual
   *  opened/loaded notice: "your file was broken, we restored the
   *  backup" outranks the routine message (#391). */
  private announceOpened(project: ProjectSummary, fallback?: string): void {
    this.events.announce(
      project.recovered
        ? ja.import.feedback.projectRecovered(project.name)
        : (fallback ?? ja.import.feedback.projectOpened(project.name)),
    );
  }

  private touchRecent(project: ProjectSummary): void {
    // A project opened from browser bytes has no durable path — the
    // recents list only records entries that can actually be reopened.
    if (!project.path) return;
    const list = recordRecentProject(
      { name: project.name, path: project.path },
      this.storage,
    );
    this.events.onRecentChange(list);
  }

  /** DEV only (#148): seed a fixture audio into the slot so a forced
   *  dev screen (#/dev/state/*, #/dev/transcribing) can drive a real
   *  job — the #219 hasAudio gate reads the slot and a layout-forced
   *  screen never imported one. Fires the normal onAudioReady wiring
   *  so transport load + identity bookkeeping stay identical to a real
   *  import. The screen lands wherever the caller forced it: the
   *  "ready"-phase onScreenChange here is superseded by the forced
   *  setScreen in the same React batch. */
  devSeedAudio(audio: LoadedAudio): void {
    this.setState({
      ...this.state,
      phase: "ready",
      audio,
      issue: null,
      sourceMissing: null,
    });
    this.events.onAudioReady(audio);
  }

  private async blobFor(ref: AudioFileRef): Promise<Blob> {
    return ref.kind === "file" ? ref.file : this.ports.readAudioBytes(ref.path);
  }

  private setState(next: ImportState): void {
    this.state = next;
    this.events.onState(next);
    const screen = screenForPhase(next.phase);
    if (screen) this.events.onScreenChange(screen);
  }
}

/** The screen states the import flow drives; "ready" is the last one it
    owns — later transitions belong to the transcription/score features. */
function screenForPhase(phase: ImportPhase): ScreenState | null {
  switch (phase) {
    case "idle":
      return "empty";
    case "opening":
      return "openingAudio";
    case "ready":
      return "audioReady";
    case "error":
      return "audioError";
    case "sourceMissing":
      return "sourceMissing";
  }
}

/* --------------------------- project parsing --------------------------- */

/**
 * UTF-8 bytes → raw project dict (JSON.parse only — no validation).
 * Engine-routed opens skip this: `project.open` parses worker-side.
 */
function parseProjectJson(bytes: ArrayBuffer): Record<string, unknown> {
  const data = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    unknown
  >;
  if (typeof data !== "object" || data === null) {
    throw new Error("project document is not an object");
  }
  return data;
}

/** UTF-8-safe base64 for `documentBase64` payloads — chunked so large
 *  project documents stay under the String.fromCharCode arg limit. */
async function blobToBase64(bytes: Blob): Promise<string> {
  const buf = new Uint8Array(await bytes.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Parse a `.hornscribe.json` document into the relink-relevant summary
 * (schema v1 — mirrors `HornScribeProject.from_dict`). Throws on malformed
 * or unsupported documents → caller maps to `projectOpenFailed`.
 *
 * This is the browser-dev/no-engine fallback parser; production opens go
 * through `project.open` on the worker (#365), which returns the already
 * normalized dict to {@link projectSummaryFromDocument}.
 */
export function parseProjectFile(
  bytes: ArrayBuffer,
  path: string,
  displayName?: string,
): ProjectSummary {
  return projectSummaryFromDocument(parseProjectJson(bytes), path, displayName);
}

/**
 * Dict → {@link ProjectSummary} — the extraction both open paths share.
 * The schema checks stay as a defensive floor: the local fallback needs
 * them, and they document the version the shell understands (#365).
 */
function projectSummaryFromDocument(
  data: Record<string, unknown>,
  path: string,
  displayName?: string,
  recovered?: boolean,
): ProjectSummary {
  if (data.schemaVersion !== 1) {
    throw new Error(`unsupported schemaVersion: ${String(data.schemaVersion)}`);
  }
  if (typeof data.projectId !== "string" || data.projectId === "") {
    throw new Error("projectId is missing or malformed");
  }
  const source = data.sourceAudio as Record<string, unknown> | null;
  return {
    path,
    projectId: data.projectId,
    name: displayName ?? projectDisplayName(path),
    sourcePath:
      source && typeof source.originalPath === "string"
        ? source.originalPath
        : null,
    sourceHash:
      source && typeof source.contentHash === "string"
        ? source.contentHash
        : null,
    scoreResult: scoreResultFromProject(data),
    transcriptionSettings: transcriptionSettingsFromProject(data),
    // #12: 区間ラベル extras を復元(壊れた行は parse 側で捨てる)。
    regionLabels: parseRegionLabels(data.regionLabels),
    recovered: recovered || undefined,
  };
}

/**
 * Reassemble the completed-job `result` shape from the project's saved
 * extras (#106). `engineDocumentFromResult` and `scoreHandoffFromResult`
 * consume this directly — the score is restored without re-transcribing.
 * Returns null when the file carries no MusicXML (externally authored
 * projects keep the AUDIO_READY-only open path).
 */
function scoreResultFromProject(
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  const concert = data.musicXmlConcert;
  const horn = data.musicXmlHornF;
  if (typeof concert !== "string" || typeof horn !== "string") {
    return null;
  }
  const score = data.score as Record<string, unknown> | null;
  return {
    musicXmlConcert: concert,
    musicXmlHornF: horn,
    musicXmlBFlat: data.musicXmlBFlat,
    scoreRevision:
      score && typeof score.revision === "string"
        ? score.revision
        : "rev-project",
    reviewIssues: Array.isArray(data.reviewIssues) ? data.reviewIssues : [],
    // #360: deferred cap-omitted issues round-trip verbatim too — a
    //  saved project keeps the full detected set, not just the tail
    //  that was surfaced when it was written.
    omittedReviewIssues: Array.isArray(data.omittedReviewIssues)
      ? data.omittedReviewIssues
      : [],
    scoreDocument: data.scoreDocument ?? null,
    meta: data.meta ?? {},
  };
}

/** #264: `transcription.settings` echo from the project file — the
 *  authoritative provenance of the conditions that produced the
 *  score. Unknown/malformed values stay raw here; the options mapper
 *  (transcriptionParams) validates them into UI state. */
function transcriptionSettingsFromProject(
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  const record = data.transcription as Record<string, unknown> | null;
  const settings = record?.settings;
  if (typeof settings !== "object" || settings === null) return null;
  return settings as Record<string, unknown>;
}
