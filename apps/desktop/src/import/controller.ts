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
import {
  audioFormatOf,
  baseName,
  projectDisplayName,
} from "./formats";
import {
  recordRecentProject,
  loadRecentProjects,
} from "./recentProjects";
import type {
  AudioFileRef,
  AudioFormat,
  ImportIssue,
  LoadedAudio,
  ProjectSummary,
  RecentProjectEntry,
  SourceMissingInfo,
} from "./types";

export type ImportPhase =
  | "idle"
  | "opening"
  | "ready"
  | "error"
  | "sourceMissing";

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

  /**
   * Drag&drop / dialog entry point. With several files the first supported
   * one wins (single-document app); zero supported → honest format error.
   */
  async importRefs(refs: readonly AudioFileRef[]): Promise<void> {
    if (refs.length === 0) return;
    const ref = refs.find((r) => audioFormatOf(r.name) !== null) ?? refs[0];
    const format = audioFormatOf(ref.name);
    if (format === null) {
      this.fail({ kind: "unsupported", fileName: ref.name });
      return;
    }
    await this.importAudioRef(ref, format);
  }

  /** OPENING_AUDIO → AUDIO_READY, or AUDIO_ERROR. */
  private async importAudioRef(
    ref: AudioFileRef,
    format: AudioFormat,
  ): Promise<void> {
    const gen = this.begin("audio", ref.name);
    try {
      const blob = await this.blobFor(ref);
      const decoded = await this.ports.decodeAudio(blob, ref.name);
      if (!this.isCurrent(gen)) return;
      const audio: LoadedAudio = {
        ref,
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
   */
  async openProject(entry: RecentProjectEntry): Promise<void> {
    const gen = this.begin("project", entry.name);
    try {
      const bytes = await this.ports.readProjectBytes(entry.path);
      const project = parseProjectFile(await bytes.arrayBuffer(), entry.path);
      if (!this.isCurrent(gen)) return;
      if (!project.sourcePath || !project.sourceHash) {
        this.enterSourceMissing(project, false);
        return;
      }
      let blob: Blob;
      try {
        blob = await this.ports.readAudioBytes(project.sourcePath);
      } catch {
        if (!this.isCurrent(gen)) return;
        this.enterSourceMissing(project, false);
        return;
      }
      const hash = await this.ports.sha256Hex(blob);
      if (!this.isCurrent(gen)) return;
      if (hash !== project.sourceHash) {
        // File at the recorded path exists but content differs —
        // store.py treats this like a moved source (verify fails).
        this.enterSourceMissing(project, false);
        return;
      }
      try {
        const decoded = await this.ports.decodeAudio(blob, entry.name);
        if (!this.isCurrent(gen)) return;
        this.finishProjectOpen(
          project,
          {
            kind: "path",
            path: project.sourcePath,
            name: baseName(project.sourcePath),
          },
          blob,
          decoded,
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
      this.fail({ kind: "projectOpenFailed", fileName: entry.name });
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
      const blob = await this.blobFor(ref);
      const hash = await this.ports.sha256Hex(blob);
      if (!this.isCurrent(gen)) return;
      if (hash !== sm.project.sourceHash) {
        this.enterSourceMissing(sm.project, true);
        return;
      }
      const decoded = await this.ports.decodeAudio(blob, ref.name);
      if (!this.isCurrent(gen)) return;
      const format = audioFormatOf(ref.name) ?? "wav";
      const audio: LoadedAudio = {
        ref,
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
      this.touchRecent(sm.project);
      this.events.onAudioReady(audio);
      this.events.announce(ja.import.feedback.sourceRelinked);
    } catch {
      if (!this.isCurrent(gen)) return;
      // Candidate unreadable or undecodable after a hash match — stay on
      // the missing-source card; the status line carries what happened
      // (the card itself already offers the retry action).
      this.enterSourceMissing(sm.project, false);
      this.events.announce(ja.import.errors.openFailedBody);
    }
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
  ): void {
    this.setState({
      phase: "sourceMissing",
      openingLabel: null,
      openingKind: null,
      audio: null,
      issue: null,
      sourceMissing: { project, mismatch },
    });
  }

  private finishProjectOpen(
    project: ProjectSummary,
    ref: AudioFileRef,
    blob: Blob,
    decoded: { durationSeconds: number; sampleRate: number; peaks: readonly number[] },
  ): void {
    const format = audioFormatOf(ref.name) ?? "wav";
    const audio: LoadedAudio = {
      ref,
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
    this.touchRecent(project);
    this.events.onAudioReady(audio);
    this.events.announce(ja.import.feedback.loaded(ref.name));
  }

  private touchRecent(project: ProjectSummary): void {
    const list = recordRecentProject(
      { name: project.name, path: project.path },
      this.storage,
    );
    this.events.onRecentChange(list);
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
 * Parse a `.hornscribe.json` document into the relink-relevant summary
 * (schema v1 — mirrors `HornScribeProject.from_dict`). Throws on malformed
 * or unsupported documents → caller maps to `projectOpenFailed`.
 */
export function parseProjectFile(
  bytes: ArrayBuffer,
  path: string,
): ProjectSummary {
  const data = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    unknown
  >;
  if (typeof data !== "object" || data === null) {
    throw new Error("project document is not an object");
  }
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
    name: projectDisplayName(path),
    sourcePath:
      source && typeof source.originalPath === "string"
        ? source.originalPath
        : null,
    sourceHash:
      source && typeof source.contentHash === "string"
        ? source.contentHash
        : null,
  };
}
