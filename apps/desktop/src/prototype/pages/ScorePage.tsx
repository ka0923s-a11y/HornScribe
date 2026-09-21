import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@fluentui/react-components";
import { ja } from "../../strings/ja";
import {
  NOTES,
  buildIssues,
  measureAtTime,
  type MockNote,
  type PitchView,
} from "../mockData";
import { useMockPlayer } from "../useMockPlayer";
import { useProtoKeys } from "../useProtoKeys";
import { ProtoScore, SCORE_METRICS } from "../ProtoScore";
import {
  ProtoProperties,
  ProtoShell,
  ReviewBanner,
  type NoteEditAction,
  type ProtoCommand,
} from "../ProtoChrome";

interface Edit {
  noteId: string;
  prevMidi: number;
  prevDeleted: boolean;
}

/**
 * P3 — score interaction (GUI_UX_SPEC §6–§11):
 * note click → canonical id → properties; playback highlight; concert /
 * F管ホルン switch preserving selection, position and loop; follow
 * suspend on manual scroll + resume; all note edits undoable (Ctrl+Z).
 */
export function ScorePage() {
  const [pitch, setPitch] = useState<PitchView>("concert");
  const [notes, setNotes] = useState<MockNote[]>(() => NOTES.map((n) => ({ ...n })));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [propsOpen, setPropsOpen] = useState(false);
  const [status, setStatus] = useState<string>(ja.prototype.status.stopped);
  const [, setUndoStack] = useState<Edit[]>([]);
  const scoreRef = useRef<HTMLDivElement>(null);
  const programmaticScroll = useRef(false);
  const player = useMockPlayer();
  const issues = useMemo(() => buildIssues(), []);

  const selected = notes.find((n) => n.id === selectedId) ?? null;
  const t = ja.prototype.transport;
  const ps = ja.prototype.status;

  /* ---- follow: scroll active measure into view (§11) ---- */
  const lastScrolledMeasure = useRef(0);
  useEffect(() => {
    if (!player.playing || player.follow !== "on") return;
    const el = scoreRef.current;
    if (!el) return;
    const measure = measureAtTime(player.positionSec);
    if (measure === lastScrolledMeasure.current) return;
    lastScrolledMeasure.current = measure;
    programmaticScroll.current = true;
    el.scrollTo({ top: SCORE_METRICS.systemTop(measure) - 20 });
    // Instant jump: the resulting scroll event lands within a tick; the
    // short guard window must not swallow genuine manual scrolls.
    const id = window.setTimeout(() => (programmaticScroll.current = false), 80);
    return () => window.clearTimeout(id);
  }, [player.playing, player.follow, player.positionSec]);

  const onScoreScroll = useCallback(() => {
    if (programmaticScroll.current) return;
    if (player.playing) player.suspendFollow();
  }, [player]);

  /* ------------------------- editing ------------------------- */

  const mutateNote = useCallback(
    (id: string, fn: (n: MockNote) => Partial<MockNote>) => {
      setNotes((list) =>
        list.map((n) => (n.id === id ? { ...n, ...fn(n) } : n)),
      );
    },
    [],
  );

  const pushUndo = useCallback((note: MockNote) => {
    setUndoStack((s) => [
      ...s,
      { noteId: note.id, prevMidi: note.midiConcert, prevDeleted: note.deleted },
    ]);
  }, []);

  const doPitchDelta = useCallback(
    (delta: number) => {
      if (!selected) return;
      pushUndo(selected);
      mutateNote(selected.id, (n) => ({ midiConcert: n.midiConcert + delta }));
      setStatus(delta > 0 ? ps.pitchFixed : ps.pitchFixed);
    },
    [selected, pushUndo, mutateNote, ps],
  );

  const onAction = useCallback(
    (a: NoteEditAction) => {
      if (!selected) return;
      pushUndo(selected);
      switch (a) {
        case "pitchUp":
          mutateNote(selected.id, (n) => ({ midiConcert: n.midiConcert + 1 }));
          setStatus(ps.pitchFixed);
          break;
        case "pitchDown":
          mutateNote(selected.id, (n) => ({ midiConcert: n.midiConcert - 1 }));
          setStatus(ps.pitchFixed);
          break;
        case "enharmonic":
          // spelling-only change: pitch identical → nothing to mutate in mock;
          // recorded on the undo stack to prove the command is undoable.
          setStatus("異名同音の表記を切り替えました");
          break;
        case "delete":
          mutateNote(selected.id, () => ({ deleted: true }));
          setStatus(ps.noteDeleted);
          break;
        case "restore":
          mutateNote(selected.id, () => ({ deleted: false }));
          setStatus(ps.noteRestored);
          break;
        case "playSource":
          player.seekTo(selected.onsetSec);
          player.play();
          setStatus(ps.simulatedSeek);
          break;
      }
    },
    [selected, pushUndo, mutateNote, ps, player],
  );

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      const last = stack[stack.length - 1];
      if (!last) {
        setStatus(ps.nothingToUndo);
        return stack;
      }
      mutateNote(last.noteId, () => ({
        midiConcert: last.prevMidi,
        deleted: last.prevDeleted,
      }));
      setStatus(ps.undone);
      return stack.slice(0, -1);
    });
  }, [mutateNote, ps]);

  /* ------------------------- navigation ------------------------- */

  const stepNote = useCallback(
    (delta: number) => {
      const list = notes.filter((n) => !n.deleted);
      if (list.length === 0) return;
      const idx = selectedId ? list.findIndex((n) => n.id === selectedId) : -1;
      const next = list[Math.min(list.length - 1, Math.max(0, idx + delta))] ?? list[0];
      setSelectedId(next.id);
      setPropsOpen(true);
      const el = scoreRef.current;
      if (el) {
        programmaticScroll.current = true;
        el.scrollTo({ top: SCORE_METRICS.systemTop(next.measure) - 20 });
        window.setTimeout(() => (programmaticScroll.current = false), 250);
      }
    },
    [notes, selectedId],
  );

  const onCommand = useCallback(
    (id: ProtoCommand) => {
      switch (id) {
        case "open":
          window.location.hash = "#/prototype/shell";
          break;
        case "transcribe":
          setStatus("プロトタイプでは採譜し直しは実行しません");
          break;
        case "review":
          window.location.hash = "#/prototype/review";
          break;
        case "export":
          window.location.hash = "#/prototype/export";
          break;
        case "settings":
          setStatus("設定画面はこのプロトタイプでは省略しています");
          break;
      }
    },
    [],
  );

  useProtoKeys(
    useMemo(
      () => [
        { combo: "Space", run: player.togglePlay },
        { combo: "Shift+Space", run: player.stop },
        { combo: "j", run: () => player.seekBy(-5) },
        { combo: "l", run: () => player.seekBy(5) },
        { combo: "Home", run: () => player.seekTo(0) },
        { combo: "End", run: () => player.seekTo(1e9) },
        { combo: "Ctrl+l", run: player.toggleLoop },
        { combo: "Ctrl+1", run: () => setPitch("concert") },
        { combo: "Ctrl+2", run: () => setPitch("hornF") },
        { combo: "Ctrl+z", run: undo },
        { combo: "Escape", run: () => setSelectedId(null) },
        { combo: "ArrowLeft", run: () => stepNote(-1) },
        { combo: "ArrowRight", run: () => stepNote(1) },
        { combo: "Alt+ArrowUp", run: () => doPitchDelta(1), enabled: () => !!selected },
        { combo: "Alt+ArrowDown", run: () => doPitchDelta(-1), enabled: () => !!selected },
        { combo: "Delete", run: () => onAction("delete"), enabled: () => !!selected && !selected.deleted },
      ],
      [player, undo, stepNote, doPitchDelta, onAction, selected],
    ),
  );

  return (
    <ProtoShell
      documentTitle={ja.prototype.shell.docTitle}
      state={{ hasAudio: true, hasScore: true, reviewCount: issues.length }}
      pitch={pitch}
      onPitch={setPitch}
      onCommand={onCommand}
      player={player}
      transportEnabled
      status={status}
      banner={
        player.follow === "paused" ? (
          <div className="hs-proto-follownote" role="status">
            <span>{t.followPaused}</span>
            <Button
              size="small"
              appearance="primary"
              onClick={() => {
                lastScrolledMeasure.current = -1; // force re-scroll to playhead
                player.resumeFollow();
              }}
            >
              {t.resumeFollow}
            </Button>
          </div>
        ) : (
          <ReviewBanner
            count={issues.filter((i) => i.status === "pending").length}
            onOpen={() => onCommand("review")}
          />
        )
      }
      properties={
        <ProtoProperties
          note={selected}
          pitch={pitch}
          open={propsOpen}
          onClose={() => setPropsOpen(false)}
          onReopen={() => setPropsOpen(true)}
          onAction={onAction}
        />
      }
    >
      <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
        <ProtoScore
          ref={scoreRef}
          notes={notes}
          pitch={pitch}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setPropsOpen(true);
          }}
          positionSec={player.positionSec}
          issues={issues.filter((i) => i.status === "pending")}
          onBackgroundClick={() => setSelectedId(null)}
          onScroll={onScoreScroll}
        />
        <div
          className="hs-proto-dev"
          style={{ margin: 0, borderWidth: "1px 0 0", borderRadius: 0 }}
        >
          <span className="hs-proto-dev__label">{ja.prototype.dev.controlsLabel}</span>
          <span>{ja.prototype.scoreView.hint}</span>
          <span aria-hidden="true">|</span>
          <span>{t.scrollHint}</span>
          <span aria-hidden="true">|</span>
          <span>{t.loopRange}: 5–8小節</span>
        </div>
      </div>
    </ProtoShell>
  );
}
